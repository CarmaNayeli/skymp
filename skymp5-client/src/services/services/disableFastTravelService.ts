import { ClientListener, Sp, CombinedController } from "./clientListener";

/**
 * Fast travel is off by default, re-asserted every tick because the game turns
 * it back on by itself in various situations.
 *
 * A gamemode can grant it per player through sp.storage.hhFastTravel, which is
 * how game masters get it while nobody else does. The client has no idea who
 * is staff, but the server does, and it can already push a value to exactly
 * one player through an owner-visible property.
 */
export class DisableFastTravelService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.onUpdate());
    }

    private onUpdate() {
        const allowed = this.sp.storage["hhFastTravel"] === true;
        this.sp.Game.enableFastTravel(allowed);
    }
}
