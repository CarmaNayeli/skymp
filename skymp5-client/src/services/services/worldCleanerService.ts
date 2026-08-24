import { ClientListener, CombinedController, Sp } from "./clientListener";
import { NiPoint3 } from "../../sync/movement";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { Actor } from "skyrimPlatform";
import { logTrace } from "../../logging";

export class WorldCleanerService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("gameLoad", () => this.onGameLoad());
  }

  modWcProtection(actorId: number, mod: number): void {
    const currentProtection = this.protection.get(actorId);
    this.protection.set(actorId, currentProtection ? currentProtection + mod : mod);
  }

  getWcProtection(actorId: number): number {
    return this.protection.get(actorId) || 0;
  }

  private onGameLoad() {
    let player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }

    this.initialPos = ObjectReferenceEx.getPos(player);
    this.initialCellOrWorld = ObjectReferenceEx.getWorldOrCell(player);
  }

  private onUpdate() {
    this.processOneActor();
  }

  private processOneActor() {
    const pc = this.sp.Game.getPlayer();
    if (pc === null) {
      return;
    }

    const actor = this.sp.Game.findRandomActor(
      pc.getPositionX(),
      pc.getPositionY(),
      pc.getPositionZ(),
      8192
    );
    if (actor === null) {
      return;
    }

    const actorId = actor.getFormID();

    const currentProtection = this.protection.get(actorId) || 0;
    if (currentProtection > 0) {
      return;
    }

    if (actorId === 0x14 || actor.isDisabled() || actor.isDeleted()) {
      return;
    }

    if (this.isActorInDialogue(actor)) {
      // Deleting actor in dialogue crashes Skyrim
      // https://github.com/skyrim-multiplayer/issue-tracker/issues/13
      actor.setPosition(0, 0, 0);
      actor.disableNoWait(true); // Seems to not crash
      return;
    }

    // Keep vanila pre-placed bodies, but delete player bodies
    if (actor.isDead() && actorId < 0xff000000) {
      actor.blockActivation(true);
      return;
    }

    // Farm animals are left where they are.
    //
    // This service exists to take Skyrim's own people out of a world that has
    // none, and it took the livestock with them. Chickens were already an
    // exception, because deleting one crashes: the note here said they fail to
    // Disable if the game loads near them, and the handling was hedged behind a
    // distance, a cell and a gameLoad that had found a player. A chicken that
    // missed all three fell through to disable-then-delete and took a player
    // down on the way into the world:
    //
    //   EXCEPTION_ACCESS_VIOLATION, cmp qword ptr [rcx+0x1F8] with rcx null
    //   R15: (Character*) "Chicken" flags kDeleted, ParentCell None
    //   RBX: (MovementControllerNPC*), R8: "IMovementMessageInterface"
    //
    // The movement controller was still holding the bird after delete() took
    // the object away from under it. Not deleting them is both the fix and the
    // better answer: a settlement wants chickens in it.
    //
    // The domestic goat is its own race, so the wild ones this server places for
    // hunters are still cleaned and hunting is untouched. Dogs are left out on
    // purpose: domestic, but not livestock, and half of them belong to quests.
    //
    // Protected rather than merely skipped, so the next pass stops at the check
    // above instead of picking the same cow again every frame.
    const livestockRaces = [
      0x000a919d, // ChickenRace
      0x0004e785, // CowRace
      0x0006fc4a, // GoatDomesticsRace
      0x000131fd, // HorseRace
      0x000de505, // CartHorseRace
    ];

    const race = actor.getRace()?.getFormID();
    if (actorId < 0xff000000 && race !== undefined && livestockRaces.includes(race)) {
      logTrace(this, `Leaving livestock alone`, actorId.toString(16));
      this.modWcProtection(actorId, 1);
      return;
    }

    actor.disable(false).then(() => {
      const ac = this.sp.Actor.from(this.sp.Game.getFormEx(actorId));
      if (!ac || this.isActorInDialogue(ac)) {
        return;
      }
      ac.delete();
    });
  }

  private isActorInDialogue(ac: Actor) {
    return ac.isInDialogueWithPlayer() || ac.getDialogueTarget() !== null;
  }

  private protection = new Map<number, number>();
  private initialPos?: NiPoint3;
  private initialCellOrWorld?: number;
}
