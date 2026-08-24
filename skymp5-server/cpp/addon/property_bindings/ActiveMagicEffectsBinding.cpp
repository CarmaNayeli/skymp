#include "ActiveMagicEffectsBinding.h"
#include "NapiHelper.h"

Napi::Value ActiveMagicEffectsBinding::Get(Napi::Env env,
                                           ScampServer& scampServer,
                                           uint32_t formId)
{
  auto& partOne = scampServer.GetPartOne();

  auto& actor = partOne->worldState.GetFormAt<MpActor>(formId);
  auto& activeMagicEffects = actor.GetActiveMagicEffects();
  // ToJson() returns nlohmann::json::array_t (a plain std::vector<json>),
  // which has no dump() of its own; wrapping it in nlohmann::json first is
  // what EquipmentBinding gets for free from Equipment::ToJson() returning a
  // full json object instead of a bare vector.
  nlohmann::json activeMagicEffectsJson = activeMagicEffects.ToJson();
  auto activeMagicEffectsDump = activeMagicEffectsJson.dump();
  return NapiHelper::ParseJson(env, activeMagicEffectsDump);
}
