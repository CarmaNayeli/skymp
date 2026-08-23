#include "CropRegeneration.h"
#include "GetBaseActorValues.h"
#include "MathUtils.h"
#include "MpActor.h"
#include "MpChangeForms.h"

namespace {

BaseActorValues GetValues(MpActor* actor)
{
  uint32_t baseId = actor->GetBaseId();
  auto appearance = actor->GetAppearance();
  uint32_t raceId = appearance ? appearance->raceId : 0;
  auto worldState = actor->GetParent();
  return GetBaseActorValues(worldState, baseId, raceId,
                            actor->GetTemplateChain());
}

}

float CropRegeneration(float newAttributeValue, float secondsAfterLastRegen,
                       float attributeRate, float attributeRateMult,
                       float oldAttributeValue, bool hasActiveMagicEffects)
{
  spdlog::trace(
    "[crop]: args=(newAttributeValue={}, secondsAfterLastRegen={}, "
    "attributerate={}, attributeRateMult={}, oldAttributeValue={}, "
    "hasActiveMagicEffects={})",
    newAttributeValue, secondsAfterLastRegen, attributeRate, attributeRateMult,
    oldAttributeValue, hasActiveMagicEffects);

  float validRegenerationPercentage =
    MathUtils::PercentToFloat(attributeRate) *
    MathUtils::PercentToFloat(attributeRateMult) * secondsAfterLastRegen;

  spdlog::trace("[crop]: validRegenerationPercentage={}",
                validRegenerationPercentage);

  validRegenerationPercentage =
    validRegenerationPercentage < 0.0f ? 0.0f : validRegenerationPercentage;
  float validAttributePercentage =
    oldAttributeValue + validRegenerationPercentage;

  spdlog::trace("[crop]: validAttributePercentage={}",
                validAttributePercentage);

  validAttributePercentage =
    validAttributePercentage > 1.0f ? 1.0f : validAttributePercentage;
  constexpr float kMaxOldPercentage = 1.f;

  spdlog::trace("[crop]: comparing received attribute value and valid one: "
                "newAttributeValue={}, validAttributePercentage={}",
                newAttributeValue, validAttributePercentage);

  // An increase past what regeneration alone allows is not cheating here.
  //
  // This used to clip anything above validAttributePercentage back down to it,
  // which is a reasonable guard against a client inventing health on a public
  // server and is catastrophic on this one. A healing spell restores far more
  // than natural regeneration ever could, so every heal was above the ceiling,
  // every heal was clipped, and the clipped value went straight back to the
  // client. What a player saw was their health filling and then snapping back
  // a moment later, every time, with nothing in any log to say why.
  //
  // The intended escape hatch is the block that used to sit here commented
  // out, and it was dead twice over. It never ran, and had it run it would
  // never have been true for a spell: hasActiveMagicEffects is only ever set
  // by ApplyMagicEffects, which the whole server calls from exactly one place,
  // EatItemEvent. Eating and drinking registered an effect. Casting did not.
  // So as far as this check was concerned, a healing spell had never happened.
  //
  // Hearthheld is invite only and every player is known, so what this guarded
  // against is not a threat here, while what it broke is most of a school of
  // magic. The bounds still hold: a percentage cannot leave nought to one, and
  // a drop is still a drop, so damage and death are untouched.
  if (newAttributeValue > kMaxOldPercentage) {
    return kMaxOldPercentage;
  }
  if (newAttributeValue < 0.0f) {
    return 0.0f;
  }
  return newAttributeValue;
}

float CropHealthRegeneration(float newAttributeValue,
                             float secondsAfterLastRegen, MpActor* actor)
{
  const BaseActorValues baseValues = GetValues(actor);
  const ActorValues& actorValues = actor->GetActorValues();
  const float rate = std::max(baseValues.healRate, actorValues.healRate);
  const float rateMult =
    std::max(baseValues.healRateMult, actorValues.healRateMult);
  const float oldPercentage = actorValues.healthPercentage;
  const bool hasActiveMagicEffects = !actor->GetActiveMagicEffects().Empty();
  return CropRegeneration(newAttributeValue, secondsAfterLastRegen, rate,
                          rateMult, oldPercentage, hasActiveMagicEffects);
}

float CropMagickaRegeneration(float newAttributeValue,
                              float secondsAfterLastRegen, MpActor* actor)
{
  const BaseActorValues baseValues = GetValues(actor);
  const ActorValues& actorValues = actor->GetActorValues();
  const float rate = std::max(baseValues.magickaRate, actorValues.magickaRate);
  const float rateMult =
    std::max(baseValues.magickaRateMult, actorValues.magickaRateMult);
  const float oldPercentage = actorValues.magickaPercentage;
  const bool hasActiveMagicEffects = !actor->GetActiveMagicEffects().Empty();
  return CropRegeneration(newAttributeValue, secondsAfterLastRegen, rate,
                          rateMult, oldPercentage, hasActiveMagicEffects);
}

float CropStaminaRegeneration(float newAttributeValue,
                              float secondsAfterLastRegen, MpActor* actor)
{
  const BaseActorValues baseValues = GetValues(actor);
  const ActorValues& actorValues = actor->GetActorValues();
  const float rate = actor->IsBlockActive()
    ? actorValues.staminaRate
    : std::max(baseValues.staminaRate, actorValues.staminaRate);
  const float rateMult =
    std::max(baseValues.staminaRateMult, actorValues.staminaRateMult);
  const float oldPercentage = actorValues.staminaPercentage;
  const bool hasActiveMagicEffects = !actor->GetActiveMagicEffects().Empty();
  return CropRegeneration(newAttributeValue, secondsAfterLastRegen, rate,
                          rateMult, oldPercentage, hasActiveMagicEffects);
}

float CropPeriodAfterLastRegen(float secondsAfterLastRegen,
                               float maxValidPeriod, float defaultPeriod)
{
  if (secondsAfterLastRegen < 0.0f) {
    return 0.0f;
  }
  if (secondsAfterLastRegen > maxValidPeriod) {
    return defaultPeriod;
  }
  return secondsAfterLastRegen;
}

float CropValue(float value, float min, float max)
{
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
