module.exports = {
    'extends': [
        '../.eslintrc.js'
    ],
    'overrides': [
        {
            'files': [ '*.ts' ],
            extends: [ '@jitsi/eslint-config/typescript' ],
            parserOptions: {
                sourceType: 'module',
                project: [ './recorder-bot/tsconfig.json' ]
            }
        }
    ]
};
