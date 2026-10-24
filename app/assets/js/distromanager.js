const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// Placeholder index with no modules yet; the real one moves to ImperiumMC hosting in milestone 2.
// See docs/distribution-index.md for what it must contain.
exports.REMOTE_DISTRO_URL = 'https://raw.githubusercontent.com/Romanica-MC/RomanicaLauncher/master/distribution/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api