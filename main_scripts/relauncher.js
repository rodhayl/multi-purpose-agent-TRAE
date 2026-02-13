const vscode = require('vscode');

const DEFAULT_CDP_PORT = 9005;

/**
 * Robust cross-platform manager for IDE shortcuts and relaunching
 */
class Relauncher {
    constructor(logger = console.log, getCdpPort = () => DEFAULT_CDP_PORT) {
        this.logger = logger;
        this.getCdpPort = typeof getCdpPort === 'function' ? getCdpPort : (() => DEFAULT_CDP_PORT);
    }

    log(msg) {
        this.logger(`[Relauncher] ${msg}`);
    }

    /**
     * Get the human-readable name of the IDE (Trae)
     */
    getIdeName() {
        return 'Trae';
    }

    /**
     * Main entry point: ensures CDP is enabled and relaunches if necessary
     */
    async ensureCDPAndRelaunch() {
        this.log('Checking launch arguments for CDP flag...');
        const hasFlag = await this.checkShortcutFlag();
        const cdpPort = this.getCdpPort();

        if (hasFlag) {
            this.log('CDP flag already present.');
            return { success: true, relaunched: false };
        }

        vscode.window.showErrorMessage(
            `Multi Purpose Agent for TRAE needs Trae to be launched with --remote-debugging-port=${cdpPort}. Please close Trae and relaunch it with --remote-debugging-port=${cdpPort}, then try again.`
        );
        return { success: false, relaunched: false };
    }

    /**
     * Platform-specific check if the current launch shortcut has the flag
     */
    async checkShortcutFlag() {
        const args = process.argv.join(' ');
        const cdpPort = this.getCdpPort();
        return args.includes(`--remote-debugging-port=${cdpPort}`);
    }
}

module.exports = { Relauncher };
