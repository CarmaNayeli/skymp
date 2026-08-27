#pragma once
#include "ActorValue.h"
#include "RecordHeader.h"

#pragma pack(push, 1)

namespace espm {

class MGEF final : public RecordHeader
{
public:
  static constexpr auto kType = "MGEF";

  enum class EffectType : uint32_t
  {
    ValueMod = 0,
    Script,
    Dispel,
    CureDisease,
    Absorb,
    Dual,
    Calm,
    Demoralize,
    Frenzy,
    Disarm,
    CommandSummoned,
    Invisibility,
    Light,
    Lock = 15,
    Open,
    BoundWeapon,
    SummonCreature,
    DetectLife,
    Telekinesis,
    Paralysis,
    Reanimate,
    SoulTrap,
    TurnUndead,
    Guide,
    WerewolfFeed,
    CureParalysis,
    CureAddiction,
    CurePoison,
    Concussion,
    ValueAndParts,
    AccumulateMagnitude,
    Stagger,
    PeakValueMod,
    Cloak,
    Werewolf,
    SlowTime,
    Rally,
    EnchanceWeapon,
    SpawnHazard,
    Etherealize,
    Banish,
    SpawnScriptedRef,
    Disguise,
    GrabActor,
    VampireLord
  };
  static_assert(static_cast<std::underlying_type_t<EffectType>>(
                  EffectType::VampireLord) == 46);

  enum class Flags : uint32_t
  {
    Hostile = 0x00000001,
    Recover = 0x00000002,
    Detrimental = 0x00000004,
    SnapToNavmesh = 0x00000008,
    NoHitEvent = 0x00000010,
    DispelEffects = 0x00000100,
    NoDuration = 0x00000200,
    NoMagnitude = 0x00000400,
    NoArea = 0x00000800,
    FXPersist = 0x00001000,
    GoryVisual = 0x00004000,
    HideInUI = 0x00008000,
    NoRecast = 0x00020000,
    PowerAffectsMagnitude = 0x00200000,
    PowerAffectsDuration = 0x00400000,
    Painless = 0x04000000,
    NoHitEffect = 0x08000000,
    NoDeathDispel = 0x10000000
  };

  struct DATA
  {
    // primary actor value
    Flags flags;
    ActorValue primaryAV = espm::ActorValue::None;
    EffectType effectType;

    // Whether any of the record's conditions asks whether somebody has a perk.
    //
    // Not the conditions themselves, which would mean evaluating them. Only
    // whether one of them is a question this side cannot answer, since perks
    // are not part of a character as the server knows one.
    //
    // Ninety three magic effects in Skyrim are gated this way, and one of them
    // is the reason this exists: PerkDisintegrateConcAimed is 200 points of
    // health damage sitting inside every shock spell in the game, conditioned
    // on the caster having Disintegrate and the target being nearly dead. To
    // anything that cannot read conditions it looks exactly like part of the
    // spell.
    bool hasPerkCondition = false;

    // The form this effect reaches for when it fires: for a Cloak that is
    // the spell laid on whoever comes near, and for a summon it is the
    // creature.
    //
    // Needed because a cloak's damage arrives as a hit from a spell the
    // wearer has never equipped and cannot cast. The Ebony Mail is the case
    // that asked for it: DA02Armor carries DA02EnchPoisonCloak, whose
    // DA02ArmorPoisonCloak effect names DA02PoisonCloakDmg here, and that
    // last one is what the client reports hitting with. Without this there
    // is no route from the armour somebody is wearing to the spell it is
    // allowed to do damage with, and every tick of it is refused.
    uint32_t associatedItemId = 0;

    [[nodiscard]] inline bool IsFlagSet(Flags flag) const
    {
      return (static_cast<uint32_t>(flags) & static_cast<uint32_t>(flag)) ==
        static_cast<uint32_t>(flag);
    }
  };

  struct Data
  {
    DATA data;
  };

  Data GetData(CompressedFieldsCache& compressedFieldsCache) const noexcept;
};

static_assert(sizeof(MGEF) == sizeof(RecordHeader));

}

#pragma pack(pop)
