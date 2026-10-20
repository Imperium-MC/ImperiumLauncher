// The only place the Azure app ID is set. Forks may not reuse another launcher's ID.
// See README.md, "Microsoft login".
exports.AZURE_CLIENT_ID = '8b0c9e33-b6ce-40ec-ac30-c85a35dd8163'

exports.AZURE_CLIENT_ID_CONFIGURED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exports.AZURE_CLIENT_ID)
    && !/^[0-]+$/.test(exports.AZURE_CLIENT_ID)


// Opcodes
exports.MSFT_OPCODE = {
    OPEN_LOGIN: 'MSFT_AUTH_OPEN_LOGIN',
    OPEN_LOGOUT: 'MSFT_AUTH_OPEN_LOGOUT',
    REPLY_LOGIN: 'MSFT_AUTH_REPLY_LOGIN',
    REPLY_LOGOUT: 'MSFT_AUTH_REPLY_LOGOUT'
}
// Reply types for REPLY opcode.
exports.MSFT_REPLY_TYPE = {
    SUCCESS: 'MSFT_AUTH_REPLY_SUCCESS',
    ERROR: 'MSFT_AUTH_REPLY_ERROR'
}
// Error types for ERROR reply.
exports.MSFT_ERROR = {
    ALREADY_OPEN: 'MSFT_AUTH_ERR_ALREADY_OPEN',
    NOT_FINISHED: 'MSFT_AUTH_ERR_NOT_FINISHED',
    NOT_CONFIGURED: 'MSFT_AUTH_ERR_NOT_CONFIGURED'
}

exports.SHELL_OPCODE = {
    TRASH_ITEM: 'TRASH_ITEM',
    OPEN_EXTERNAL: 'SHELL_OPEN_EXTERNAL'
}