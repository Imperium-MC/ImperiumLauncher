/**
 * assetdl.js — Imperium asset download pipeline.
 *
 * Two roles in one module:
 *
 *  1. When forked as a child process (by ImperiumRepair.spawnReceiver),
 *     it acts as the receiver: validates the selected server's files and
 *     downloads the invalid ones. It extends the stock helios-core
 *     FullRepair protocol with two additional messages so the UI can show
 *     per-artifact progress and retry state:
 *
 *       { response: 'downloadFile',  name, index, count, percent }
 *       { response: 'downloadRetry', name, attempt, max, delayMs }
 *
 *     Each artifact is retried up to MAX_RETRIES times with exponential
 *     backoff (1s / 2s / 4s) before the whole sync is declared failed.
 *
 *  2. When required from the renderer (landing.js), it exports
 *     ImperiumRepair, the transmitter half. It mirrors the public surface
 *     of helios-core's FullRepair (spawnReceiver/destroyReceiver/
 *     childProcess/verifyFiles/download) so it can be dropped in without
 *     touching the rest of the launch flow.
 *
 * The receiver reimplements the validate/download stages with
 * helios-core's public API (DistributionAPI, MojangIndexProcessor,
 * DistributionIndexProcessor) so the behavior stays identical to the
 * upstream FullRepairReceiver, with the retry and per-file events added.
 */

const childProcess = require('child_process')
const fs = require('fs-extra')
const path = require('path')
const got = require('got')
const { pipeline } = require('stream/promises')

const { LoggerUtil } = require('helios-core')
const { DistributionAPI, validateLocalFile } = require('helios-core/common')
const {
    MojangIndexProcessor,
    DistributionIndexProcessor,
    getExpectedDownloadSize
} = require('helios-core/dl')

const log = LoggerUtil.getLogger('AssetDL')

/* Receiver constants. */

// Retries per artifact after the initial attempt (3 retries => 4 attempts total).
const MAX_RETRIES = 3
// Base delay for the exponential backoff: 1s, 2s, 4s.
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.ASSETDL_RETRY_BASE_MS || '1000', 10) || 1000
// Parallel downloads, matches helios-core's downloadQueue concurrency.
const CONCURRENCY = 15
// Minimum interval between per-file progress messages for a single file (~4/s).
const FILE_EVENT_MIN_INTERVAL_MS = 250

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Convert a caught error into a user displayable message,
 * mirroring helios-core FullRepairReceiver.parseError.
 */
function parseDisplayableError(error) {
    if(error instanceof got.RequestError) {
        if(error?.request?.requestUrl) {
            log.debug(`Error during request to ${error.request.requestUrl}`)
        }
        if(error instanceof got.HTTPError) {
            return `Error during request (HTTP Response ${error.response.statusCode})`
        } else if(error.name === 'RequestError') {
            return `Request received no response (${error.code}).`
        } else if(error instanceof got.TimeoutError) {
            return `Request timed out (${error.timings.phases.total}ms).`
        } else if(error instanceof got.ParseError) {
            return 'Request received unexepected body (Parse Error).'
        } else if(error instanceof got.ReadError) {
            return `Read Error (${error.code}): ${error.message}.`
        }
        return 'Error during request.'
    }
    return undefined
}

/* Receiver implementation. */

const receiver = {
    processors: [],
    assets: []
}

/**
 * Validate stage, identical to helios-core FullRepairReceiver.validate.
 */
async function receiverValidate(message) {
    const api = new DistributionAPI(
        message.launcherDirectory,
        message.commonDirectory,
        message.instanceDirectory,
        null, // Local pull only, the main process handles refreshes.
        message.devMode
    )
    const distribution = await api.getDistributionLocalLoadOnly()
    const server = distribution.getServerById(message.serverId)

    const mojangIndexProcessor = new MojangIndexProcessor(message.commonDirectory, server.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(message.commonDirectory, distribution, message.serverId)

    receiver.processors = [
        mojangIndexProcessor,
        distributionIndexProcessor
    ]

    let numStages = 0
    for(const processor of receiver.processors) {
        await processor.init()
        numStages += processor.totalStages()
    }

    const assets = []
    let completedStages = 0
    for(const processor of receiver.processors) {
        Object.values(await processor.validate(async () => {
            completedStages++
            process.send({ response: 'validateProgress', percent: Math.trunc((completedStages / numStages) * 100) })
        }))
            .flatMap(asset => asset)
            .forEach(asset => assets.push(asset))
    }

    receiver.assets = assets
    process.send({ response: 'validateComplete', invalidCount: receiver.assets.length })
}

/**
 * Download stage with per-artifact retry and per-file progress events.
 *
 * @param {Object} message Optional. May carry an `assets` array to
 * download instead of the set produced by the validate stage. The
 * transmitter never sends one; it exists so the stage can be driven
 * standalone (diagnostics, tests).
 */
async function receiverDownload(message = {}) {
    if(Array.isArray(message.assets)) {
        receiver.assets = message.assets
    }
    const assets = receiver.assets
    const count = assets.length
    const expectedTotalSize = getExpectedDownloadSize(assets)
    log.debug(`Downloading ${count} artifacts, expected size ${expectedTotalSize} bytes.`)
    assets.forEach(({ id }) => log.debug(`Asset Requires Download: ${id}`))

    // Aggregate progress accounting, robust to a file restarting after a retry.
    const receivedEach = {}
    let received = 0
    let currentPercent = expectedTotalSize > 0 ? -1 : 100

    // Per-file progress throttling state.
    const lastFileEmit = {}

    function sendAggregateProgress() {
        if(expectedTotalSize <= 0) {
            return
        }
        const nextPercent = Math.max(0, Math.min(100, Math.trunc((received / expectedTotalSize) * 100)))
        if(nextPercent !== currentPercent) {
            currentPercent = nextPercent
            process.send({ response: 'downloadProgress', percent: currentPercent })
        }
    }

    function sendFileProgress(asset, index, transferredThisFile) {
        const now = Date.now()
        if(lastFileEmit[asset.id] != null && (now - lastFileEmit[asset.id]) < FILE_EVENT_MIN_INTERVAL_MS) {
            return
        }
        lastFileEmit[asset.id] = now
        let percent = null
        if(asset.size > 0) {
            percent = Math.max(0, Math.min(100, Math.trunc((transferredThisFile / asset.size) * 100)))
        }
        process.send({ response: 'downloadFile', name: path.basename(asset.path), index, count, percent })
    }

    /**
     * Stream a single artifact to disk, updating aggregate + per-file progress.
     */
    async function streamArtifact(asset, index) {
        await fs.ensureDir(path.dirname(asset.path))
        const downloadStream = got.stream(asset.url)
        const fileWriterStream = fs.createWriteStream(asset.path)
        downloadStream.on('downloadProgress', ({ transferred }) => {
            const previous = receivedEach[asset.id] || 0
            if(transferred > previous) {
                received += transferred - previous
                receivedEach[asset.id] = transferred
                sendAggregateProgress()
                sendFileProgress(asset, index, transferred)
            }
        })
        try {
            await pipeline(downloadStream, fileWriterStream)
        } finally {
            fileWriterStream.destroy()
        }
    }

    /**
     * Download one artifact with bounded retry and exponential backoff.
     * Emits a downloadRetry message before each retry so the UI can
     * display a "retrying (n/3)" state.
     */
    async function downloadArtifact(asset, index) {
        const name = path.basename(asset.path)
        for(let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if(attempt > 0) {
                const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
                log.warn(`Retry ${attempt}/${MAX_RETRIES} for ${asset.id} in ${delayMs}ms.`)
                process.send({ response: 'downloadRetry', name, attempt, max: MAX_RETRIES, delayMs })
                await sleep(delayMs)
                // Restart accounting for this artifact so the aggregate bar stays truthful.
                received -= receivedEach[asset.id] || 0
                receivedEach[asset.id] = 0
                sendAggregateProgress()
            }
            try {
                await streamArtifact(asset, index)
                return
            } catch(err) {
                log.error(`Download attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${asset.id}: ${err.message || err}`)
                if(attempt === MAX_RETRIES) {
                    const displayable = `File ${name} failed to download after ${MAX_RETRIES + 1} attempts.`
                    const cause = parseDisplayableError(err) || err.message || String(err)
                    const wrapped = new Error(`${displayable} (${cause})`)
                    wrapped.displayable = `${displayable}<br><span style="font-size: 10px;">${cause}</span>`
                    throw wrapped
                }
            }
        }
    }

    // Worker pool, same concurrency as helios-core's fastq queue.
    let nextIndex = 0
    const workerCount = Math.max(1, Math.min(CONCURRENCY, count))
    const workers = []
    for(let w = 0; w < workerCount; w++) {
        workers.push((async () => {
            while(true) {
                const index = nextIndex++
                if(index >= count) {
                    return
                }
                await downloadArtifact(assets[index], index + 1)
            }
        })())
    }
    await Promise.all(workers)

    // Size/hash sanity pass, mirrors helios-core behavior.
    for(const asset of assets) {
        if(asset.size !== receivedEach[asset.id]) {
            log.warn(`Asset ${asset.id} declared a size of ${asset.size} bytes, but ${receivedEach[asset.id]} were received!`)
            if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
                log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            }
        }
    }
    for(const processor of receiver.processors) {
        await processor.postDownload()
    }

    if(expectedTotalSize > 0) {
        process.send({ response: 'downloadProgress', percent: 100 })
    }
    process.send({ response: 'downloadComplete' })
}

/**
 * Receiver entry, active when this file is forked as a child process.
 */
function startReceiverLoop() {
    log.info('Receiver process started.')

    process.on('message', async (message) => {
        try {
            switch(message.action) {
                case 'validate':
                    await receiverValidate(message)
                    break
                case 'download':
                    await receiverDownload(message)
                    break
            }
        } catch(err) {
            log.error('Error during receiver operation.')
            log.error(err)
            process.send({
                response: 'error',
                displayable: err.displayable || parseDisplayableError(err)
            })
            // Match helios-core: terminate on first unhandled error.
            setImmediate(() => process.exit(1))
        }
    })

    process.on('disconnect', () => {
        log.info('Disconnect signal received, shutting down.')
        process.exit(0)
    })
}

/* Transmitter implementation. */

/**
 * Drop-in replacement for helios-core's FullRepair transmitter which
 * forks this same file as the receiver, translating the extended
 * message protocol into callbacks.
 */
class ImperiumRepair {
    constructor(commonDirectory, instanceDirectory, launcherDirectory, serverId, devMode) {
        this.commonDirectory = commonDirectory
        this.instanceDirectory = instanceDirectory
        this.launcherDirectory = launcherDirectory
        this.serverId = serverId
        this.devMode = devMode
        this.receiver = null
    }

    spawnReceiver() {
        if(this.receiver != null) {
            throw new Error('Receiver already spawned!')
        }
        this.receiver = childProcess.fork(__filename, [], { stdio: 'pipe' })
        this.receiver.stdio[1].setEncoding('utf8')
        this.receiver.stdio[1].on('data', (data) => {
            `${data}`.trim().split('\n')
                .forEach(line => console.log(`\x1b[32m[_]\x1b[0m ${line}`))
        })
        this.receiver.stdio[2].setEncoding('utf8')
        this.receiver.stdio[2].on('data', (data) => {
            `${data}`.trim().split('\n')
                .forEach(line => console.log(`\x1b[31m[_]\x1b[0m ${line}`))
        })
    }

    destroyReceiver() {
        if(this.receiver != null) {
            this.receiver.disconnect()
            this.receiver = null
        }
    }

    get childProcess() {
        return this.receiver
    }

    verifyFiles(onProgress) {
        return new Promise((resolve, reject) => {
            const onMessageHandle = (message) => {
                switch(message.response) {
                    case 'validateProgress':
                        log.debug('Received validate progress ' + message.percent)
                        onProgress(message.percent)
                        break
                    case 'validateComplete':
                        log.info('Received validation complete.')
                        this.receiver.removeListener('message', onMessageHandle)
                        resolve(message.invalidCount)
                        break
                    case 'error':
                        log.error('Received error.')
                        this.receiver.removeListener('message', onMessageHandle)
                        this.destroyReceiver()
                        reject(message)
                        break
                }
            }
            this.receiver.on('message', onMessageHandle)
            this.receiver.send({
                action: 'validate',
                commonDirectory: this.commonDirectory,
                instanceDirectory: this.instanceDirectory,
                launcherDirectory: this.launcherDirectory,
                serverId: this.serverId,
                devMode: this.devMode
            })
        })
    }

    /**
     * @param {function} onProgress Aggregate percent callback (0-100).
     * @param {function} onFileProgress Per-artifact callback
     * ({name, index, count, percent}), throttled to ~4/s per file.
     * @param {function} onRetry Retry notification callback
     * ({name, attempt, max, delayMs}).
     */
    download(onProgress, onFileProgress = null, onRetry = null) {
        return new Promise((resolve, reject) => {
            const onMessageHandle = (message) => {
                switch(message.response) {
                    case 'downloadProgress':
                        log.debug('Received download progress ' + message.percent)
                        onProgress(message.percent)
                        break
                    case 'downloadFile':
                        if(onFileProgress != null) {
                            onFileProgress(message)
                        }
                        break
                    case 'downloadRetry':
                        log.warn(`Received retry ${message.attempt}/${message.max} for ${message.name}`)
                        if(onRetry != null) {
                            onRetry(message)
                        }
                        break
                    case 'downloadComplete':
                        log.info('Received download complete.')
                        this.receiver.removeListener('message', onMessageHandle)
                        resolve()
                        break
                    case 'error':
                        log.error('Received error.')
                        this.receiver.removeListener('message', onMessageHandle)
                        this.destroyReceiver()
                        reject(message)
                        break
                }
            }
            this.receiver.on('message', onMessageHandle)
            this.receiver.send({
                action: 'download'
            })
        })
    }
}

exports.ImperiumRepair = ImperiumRepair
exports.MAX_RETRIES = MAX_RETRIES
exports.RETRY_BASE_DELAY_MS = RETRY_BASE_DELAY_MS

// Fork guard: only run the receiver loop when executed as a child process.
if(process.send != null && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    startReceiverLoop()
}
