import { MsgType } from "../../messages";

export interface SpellCastMsgData {
    caster: number
    target: number
    spell: number
    isDualCasting: boolean
    interruptCast: boolean
    castingSource: number
    aimAngle: number,
    aimHeading: number,
    // Optional, because the game does not always have an answer. An actor
    // it cannot look up yields nothing, and a message that says nothing
    // about how the cast looked is worth far more than one never sent: the
    // interrupt that stops a beam travels on this same message.
    actorAnimationVariables?: {
        booleans: number[]
        floats: number[]
        integers: number[]
    }
}

export interface SpellCastMessage {
    t: MsgType.SpellCast,
    data: SpellCastMsgData
}
