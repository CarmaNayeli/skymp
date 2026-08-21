import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logError, logTrace } from "../../logging";
import { ChangeFormNpc } from "skyrimPlatform";

export class LoadGameService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("loadGame", () => this.onLoadGame());
    }

    /**
     * Whether a load has ever completed, and whether one is running now.
     *
     * Asked rather than announced on purpose. This used to be published only
     * as the gameLoad event, so anything wanting to know had to be listening
     * at the right moment: a listener registered one tick after the load
     * finished waited for ever. That is not hypothetical, it is what stopped
     * the race menu opening once the server started asking for it after the
     * arrival rather than during it. State survives being asked late; an event
     * does not.
     */
    public get hasFinishedLoadingOnce(): boolean {
        return this._hasEverLoaded;
    }

    public get isLoadingGame(): boolean {
        return this._isLoading;
    }

    public loadGame(pos: number[], rot: number[], worldOrCell: number, changeFormNpc?: ChangeFormNpc, loadOrder?: string[], time?: { seconds: number, minutes: number, hours: number }) {
        this._isLoading = true;
        // Traced on both sides of the call, because this is where people have
        // been getting stuck and the log went quiet at exactly this point. A
        // line before and nothing after cannot distinguish loadGame throwing,
        // returning and the load never finishing, or the appearance retry below
        // being taken. Those want different fixes.
        logTrace(this, `loadGame: cell ${worldOrCell.toString(16)}, pos ${JSON.stringify(pos)},`,
            `${loadOrder ? loadOrder.length : 0} plugin(s), appearance ${changeFormNpc ? "yes" : "no"},`,
            `hour ${time ? time.hours : "none"}`);
        // Named, not just counted. A count that differs from the server's is
        // the whole problem and "8 plugin(s)" does not say which two, so the
        // next question was always going to be this one.
        logTrace(this, `loadGame plugins: ${loadOrder ? loadOrder.join(", ") : "none"}`);
        try {
            // @ts-ignore
            this.sp.loadGame(pos, rot, worldOrCell, changeFormNpc, loadOrder, time);
            logTrace(this, `loadGame returned`);
            this.watchLoad();
        } catch (e) {
            // Hotfix non-vanilla headparts bug
            logError(this, `loadGame threw, retrying without appearance:`, e);
            try {
                // @ts-ignore
                this.sp.loadGame(pos, rot, worldOrCell, undefined, loadOrder, time);
                logTrace(this, `loadGame returned on the retry`);
            } catch (e2) {
                // Previously this escaped and took the caller with it, so the
                // rest of spawning never ran and there was nothing in the log
                // to say why.
                logError(this, `loadGame threw on the retry as well:`, e2);
            }
        }
        this._isCausedBySkyrimPlatform = true;
    }

    /**
     * Says what the game is doing while it fails to finish loading.
     *
     * "loadGame returned" followed by silence is where people have been
     * getting stuck, and that one line cannot tell apart the three things it
     * could mean. Sitting on a loading screen forever is a data problem;
     * sitting at the main menu means loadGame quietly did nothing; standing in
     * the world means the load worked and only the event went missing. Each
     * wants a different fix, and guessing between them has cost days.
     *
     * Driven off tick rather than Utility.wait, because game time does not
     * advance on a loading screen and the wait would never return, which is
     * exactly the case this has to report on.
     */
    private watchLoad() {
        if (this._loadWatchdogActive) {
            return;
        }
        this._loadWatchdogActive = true;
        this._sawLoadEvent = false;
        this._sawUpdate = false;
        // One shot, purely to learn whether the game ever starts running.
        this.controller.once("update", () => { this._sawUpdate = true; });
        const started = Date.now();
        let nextReport = 5000;
        const step = () => {
            if (this._sawLoadEvent) {
                this._loadWatchdogActive = false;
                return;
            }
            const elapsed = Date.now() - started;
            if (elapsed >= nextReport) {
                this.reportLoadState(Math.round(elapsed / 1000));
                nextReport += 5000;
                // A minute is well past any honest load, and a trace repeating
                // forever would bury whatever comes after it.
                if (elapsed >= 60000) {
                    logTrace(this, `still not loaded after a minute, no longer watching`);
                    this._loadWatchdogActive = false;
                    return;
                }
            }
            this.controller.once("tick", step);
        };
        this.controller.once("tick", step);
    }

    private reportLoadState(seconds: number) {
        // Deliberately reads nothing from the game. Ui.isMenuOpen and
        // Game.getPlayer are only callable on the game thread, which
        // SkyrimPlatform hands us in the update event and not in tick, and
        // this runs on tick precisely because tick keeps firing while the game
        // is loading and update does not. Calling them here throws "can't be
        // called in this context" once per frame and reports nothing.
        //
        // That the update event has not fired is itself the answer worth
        // having: it means the game has not reached the world yet, which is
        // the difference between a slow load and a load that is never going to
        // finish.
        logTrace(
            this,
            `still loading after ${seconds}s:`,
            this._sawUpdate ? `the game is running but the load never completed` : `the game has not started running yet`,
        );
    }

    private onLoadGame() {
        this._sawLoadEvent = true;
        this._isLoading = false;
        this._hasEverLoaded = true;
        logTrace(this, `game finished loading, caused by us: ${this._isCausedBySkyrimPlatform}`);
        try {
            const gameLoadEvent = {
                isCausedBySkyrimPlatform: this._isCausedBySkyrimPlatform
            };
            this.controller.emitter.emit("gameLoad", gameLoadEvent);
        } catch (e) {
            this.controller.once("tick", () => {
                this._isCausedBySkyrimPlatform = false;
            });
            throw e;
        }
        this.controller.once("tick", () => {
            this._isCausedBySkyrimPlatform = false;
        });
    }

    private _isCausedBySkyrimPlatform = false;
    private _loadWatchdogActive = false;
    private _sawLoadEvent = false;
    private _sawUpdate = false;
    private _hasEverLoaded = false;
    private _isLoading = false;
}
