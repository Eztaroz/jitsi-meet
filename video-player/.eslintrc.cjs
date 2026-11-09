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
                project: [ './video-player/tsconfig.json' ]
            }
        }
    ]
};
