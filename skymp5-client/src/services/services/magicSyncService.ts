// TODO: refactor this out
import { localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";

// @ts-expect-error (TODO: Remove in 2.10.0)
import { SpellCastEvent, Actor, printConsole, Game, getAnimationVariablesFromActor, ActorAnimationVariables, SpellType, SlotType, EquippedItemType } from 'skyrimPlatform'
import { ClientListener, CombinedController, Sp } from './clientListener';
import { logTrace } from '../../logging';

import { MsgType } from "../../messages";
import { SpellCastMsgData, SpellCastMessage } from "../messages/spellCastMessage";
import { UpdateAnimVariablesMessageMsgData } from "../messages/updateAnimVariablesMessage";

export class MagicSyncService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.onUpdate());
        this.controller.on("spellCast", (e) => this.onSpellCast(e));

        const self = this;


        this.sp.hooks.sendAnimationEvent.add({
            enter: (ctx) => { },
            leave: (ctx) => {
                self.onSendAnimationEventLeave(ctx);
            }
        }, this.playerId, this.playerId);
    }

    private onUpdate() {
        // Whether the game itself still thinks this hand is channelling, polled
        // every tick rather than inferred from an animation event.
        //
        // The only interrupt trigger used to be mlh/mrh_equipped_event, which is
        // the re-equip animation: it fires on sheathing or switching gear, not on
        // simply letting go of a concentration spell's trigger. So releasing
        // Flames or Sparks stopped the beam locally and told nobody, and every
        // other client kept its own copy of the caster looping the channel
        // animation and applying the effect, since nothing ever said to stop.
        // That is the whole shape of "it stops for you but not for them, and it
        // still hurts": each client is right about what it was told and wrong
        // about what actually happened.
        //
        // These three animation variables are read the same way already, a few
        // lines below in sendInputsService, to decide whether an actor value
        // update should wait out a cast rather than fight it. Reusing a signal
        // already proven reliable there is safer than trusting a fresh guess.
        const player = this.sp.Game.getPlayer();
        this.sampleCrosshair();
        const isCastingNow = !!player && (
            player.getAnimationVariableBool("IsCastingRight") ||
            player.getAnimationVariableBool("IsCastingLeft") ||
            player.getAnimationVariableBool("IsCastingDual")
        );
        if (this.wasCastingLastUpdate && !isCastingNow) {
            this.sendInterruptForLastCast();
        }
        this.wasCastingLastUpdate = isCastingNow;

        if (this.isAnyMagicStuffEquiped() === false) {
            return;
        }

        if (Date.now() - this.lastSendUpdateAnimationVariables <= this.sendUpdateAnimationVariablesRateMs) {
            return;
        }

        this.lastSendUpdateAnimationVariables = Date.now();

        this.controller.once('update', () => {
            const ac = Game.getPlayer();

            if (!ac) {
                return;
            }

            const animVariables = this.getAnimationVariablesFromActorConverted(ac.getFormID());

            this.controller.emitter.emit("sendMessage", {
                message: { t: MsgType.UpdateAnimVariables, data: this.getUpdateAnimVariablesEventData(ac, animVariables) },
                reliability: "reliable"
            });
        });

    }

    /**
     * Who the player is pointing at, kept fresh for the next cast.
     *
     * Read here rather than when a cast happens, because this is the game
     * thread and a cast event is not somewhere a Papyrus question can safely
     * be asked. A hundred milliseconds old is the same answer: nobody swings
     * a crosshair off a person and casts at them in less time than that.
     */
    private sampleCrosshair() {
        const now = Date.now();
        if (now - this.lastCrosshairAt < 100) {
            return;
        }
        this.lastCrosshairAt = now;
        try {
            const looked = this.sp.Game.getCurrentCrosshairRef();
            const actor = looked ? this.sp.Actor.from(looked) : null;
            this.crosshairActorId = actor ? actor.getFormID() : 0;
        } catch (e) {
            this.crosshairActorId = 0;
        }
    }

    private crosshairActorId = 0;
    private lastCrosshairAt = 0;

    /**
     * Who a cast is aimed at, which Skyrim mostly declines to say.
     *
     * SpellCastEvent fills in a target for a spell that has one and leaves it
     * empty for an aimed spell, which is nearly every spell anybody points at
     * another person. That empty target travelled all the way to the other
     * machine and became a null magicTarget, and a concentration spell cast at
     * no target does nothing at all.
     *
     * Which is the whole of healing never working. Damage never needed this,
     * because damage is reported down a different road, the hit path, and a
     * hit always knows what it hit. A heal has no hit. It had nothing but this
     * field, and this field was empty, so a healer's spell was replayed on the
     * healed player's machine aimed at nobody and their health never moved.
     * What the healer saw improving was their own copy of the other person.
     *
     * So an aimed cast falls back to what the caster is looking at. Only for
     * the local player, since nobody else's crosshair is knowable from here,
     * and only when it is an actor: a heal aimed at a chair is aimed at
     * nothing, and saying so plainly is better than sending a chair.
     */
    private targetOf(e: SpellCastEvent): number {
        // @ts-expect-error (TODO: Remove in 2.10.0)
        const named = e.target;
        if (named) {
            return localIdToRemoteId(named.getFormID(), true);
        }
        if (!this.crosshairActorId) {
            return 0;
        }
        const player = this.sp.Game.getPlayer();
        if (!player || !e.caster || e.caster.getFormID() !== player.getFormID()) {
            return 0;
        }
        return localIdToRemoteId(this.crosshairActorId, true);
    }

    private onSpellCast(event: SpellCastEvent) {
        const isInterruptCast = false;

        const msg: SpellCastMsgData = this.getSpellCastEventData(event, isInterruptCast);

        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.SpellCast, data: msg },
            reliability: "reliable"
        });

        this.lastSpellCastEventMsg = msg;
    }

    private onSendAnimationEventLeave(ctx: { animEventName: string, animationSucceeded: boolean }) {

        if (!this.lastSpellCastEventMsg || !this.isInteraptSpellCastAnim(ctx.animEventName)) {
            return;
        }

        this.controller.once('update', () => {
            this.sendInterruptForLastCast();
        });

    }

    // The one place an interrupt actually gets sent, so the two triggers above
    // cannot drift into sending it two different ways. Left as two triggers on
    // purpose rather than merged into one: the animation event still catches an
    // instant cast interrupted by something else, like a stagger, and the polled
    // variables catch the ordinary case of just letting go.
    private sendInterruptForLastCast() {
        if (!this.lastSpellCastEventMsg || this.lastSpellCastEventMsg.interruptCast) {
            return;
        }

        let msg: SpellCastMsgData = this.lastSpellCastEventMsg;
        msg.interruptCast = true;
        msg.actorAnimationVariables = this.getAnimationVariablesFromActorConverted(remoteIdToLocalId(this.lastSpellCastEventMsg.caster));

        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.SpellCast, data: msg },
            reliability: "reliable"
        });
    }

    private getSpellCastEventData(e: SpellCastEvent, isInterruptCast: boolean): SpellCastMsgData {
        const spellCastData: SpellCastMsgData = {
            caster: localIdToRemoteId(e.caster.getFormID(), true),
            target: this.targetOf(e),
            spell: e.spell ? e.spell.getFormID() : 0,
            interruptCast: isInterruptCast,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            isDualCasting: e.isDualCasting,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            castingSource: e.castingSource,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            aimAngle: e.aimAngle,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            aimHeading: e.aimHeading,
            actorAnimationVariables: this.getAnimationVariablesFromActorConverted(e.caster.getFormID()),
        }
        return spellCastData;
    }

    /**
     * The caster's animation variables, or nothing if the game has no answer.
     *
     * getAnimationVariablesFromActor returns undefined for an actor it cannot
     * look up, and reading .booleans straight off that throws. Which would be
     * a small thing, except for where it is called from.
     *
     * sendInterruptForLastCast asks for the variables before it sends the
     * interrupt. So a caster the game could not look up meant the throw landed
     * first and the interrupt was never sent at all: the beam stopped on the
     * caster's own screen and went on burning, and hurting, on everybody
     * else's until they sheathed. That is the flames that would not stop, and
     * it is the same missing field that flooded every reader near a caster
     * with exceptions once the message did go out.
     *
     * So this answers with nothing rather than throwing, and the callers treat
     * nothing as a message worth sending anyway. What these variables decide
     * is how a cast looks. Whether it has stopped is not theirs to hold up.
     */
    private getAnimationVariablesFromActorConverted(actorId: number) {
        const animVars = getAnimationVariablesFromActor(actorId);
        if (!animVars) {
            return undefined;
        }
        const booleans: ArrayBuffer = animVars.booleans;
        const floats: ArrayBuffer = animVars.floats;
        const integers: ArrayBuffer = animVars.integers;
        return {
            booleans: Array.from(new Uint8Array(booleans)),
            floats: Array.from(new Uint8Array(floats)),
            integers: Array.from(new Uint8Array(integers)),
        }
    }

    private getUpdateAnimVariablesEventData(ac: Actor, animVariables: ActorAnimationVariables | undefined): UpdateAnimVariablesMessageMsgData {
        const animVarsData: UpdateAnimVariablesMessageMsgData = {
            actorRemoteId: localIdToRemoteId(ac.getFormID(), true),
            actorAnimationVariables: animVariables,
        }
        return animVarsData;
    }

    // What counts as a cast ending.
    //
    // The two equipped events alone were the whole of this, and they are the
    // re-equip animation: they fire on sheathing or switching gear, not on
    // letting go of a concentration spell's trigger. So Flames went on burning
    // on every screen but the caster's until they put their hands away, which
    // is the bug this was supposed to have fixed and did not.
    //
    // The release events are the ones that actually mean let go, and the file
    // already knew their names: isSpellCastAnim below has listed both since
    // before any of this, so these are not a guess about what the behaviour
    // graph calls things.
    //
    // Harmless on a fire and forget spell, where release fires once the
    // projectile is away: remote clients cast those with castSpellImmediate,
    // so there is nothing left running for the interrupt to stop.
    private isInteraptSpellCastAnim(animEventName: string): boolean {
        const eventName = animEventName.toLowerCase();
        return eventName === "mlh_equipped_event" || eventName === "mrh_equipped_event"
            || eventName === "mlh_spellrelease_event" || eventName === "mrh_spellrelease_event";
    };

    private isSpellCastAnim(animEventName: string): boolean {
        const eventName = animEventName.toLowerCase();

        const isSpellCastAnimForLeftHand = eventName === "mlh_spellaimedconcentrationstart" || eventName === "mlh_spellaimedstart" || eventName === "mlh_spellready_event" ||
            eventName === "mlh_spellrelease_event" || eventName === "mlh_equipped_event";

        const isSpellCastAnimForRightHand = eventName === "mrh_spellaimedconcentrationstart" || eventName === "mrh_spellaimedstart" || eventName === "mrh_spellready_event" ||
            eventName === "mrh_spellrelease_event" || eventName === "mrh_equipped_event";

        return isSpellCastAnimForLeftHand || isSpellCastAnimForRightHand;
    };

    private isAnyMagicStuffEquiped(): boolean {
        const ac = Game.getPlayer();

        if (!ac) {
            return false;
        }

        if (ac.getEquippedSpell(SpellType.Left) || ac.getEquippedSpell(SpellType.Right)) {
            return true;
        }

        if (ac.getEquippedSpell(SpellType.Voise) || ac.getEquippedSpell(SpellType.Instant)) {
            return true;
        }

        const leftHandEquipmentType = ac.getEquippedItemType(SlotType.Left);
        const rightHandEquipmentType = ac.getEquippedItemType(SlotType.Right);

        if (leftHandEquipmentType === 9 || leftHandEquipmentType === EquippedItemType.Staff ||
            rightHandEquipmentType === 9 || rightHandEquipmentType === EquippedItemType.Staff) {
            return true;
        }

        return false;
    }

    private playerId = 0x14;
    private sendUpdateAnimationVariablesRateMs = 500;
    private lastSpellCastEventMsg: SpellCastMsgData | null = null;
    private lastSendUpdateAnimationVariables: number = 0;
    private wasCastingLastUpdate = false;
}
