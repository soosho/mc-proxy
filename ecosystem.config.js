module.exports = {
    apps: [{
        name: "stratum-proxy",
        script: "./proxy.js",
        instances: 1,
        exec_mode: "fork",
        watch: false,
        env: {
            NODE_ENV: "production",
            // All other env vars are loaded from .env automatically
            // or you can specify them here
        },
        error_file: "./logs/err.log",
        out_file: "./logs/out.log",
        merge_logs: true,
        autorestart: true,
    }]
};
