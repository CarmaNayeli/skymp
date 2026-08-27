#include "SkympGetDistanceFromHome.h"
#include "MpActor.h"
#include "MpObjectReference.h"
#include "WorldState.h"
#include <cmath>
#include <limits>

const char* ConditionFunctions::SkympGetDistanceFromHome::GetName() const
{
  return "SkympGetDistanceFromHome";
}

uint16_t ConditionFunctions::SkympGetDistanceFromHome::GetFunctionIndex() const
{
  // Not a vanilla condition, so it has no index in Bethesda's table and is
  // reached by name only, the same as the other Skymp* functions here.
  return std::numeric_limits<uint16_t>::max();
}

float ConditionFunctions::SkympGetDistanceFromHome::Execute(
  MpActor& actor, [[maybe_unused]] uint32_t parameter1,
  [[maybe_unused]] uint32_t parameter2, const ConditionEvaluatorContext&)
{
  // "Far away" rather than zero for every case this cannot answer.
  //
  // The direction matters. A server writes its gentler bands as "closer than
  // N", so an unknown answering zero would read as standing on the doorstep
  // and would quietly apply the easiest band everywhere: in every interior, on
  // every server that never configured a home, and on any hit arriving while
  // the world was still coming up. Answering far leaves the default alone,
  // which is the behaviour of not having configured this at all.
  const float kFarAway = std::numeric_limits<float>::max();

  WorldState* worldState = actor.GetParent();
  if (!worldState || !worldState->difficultyHomeSet) {
    return kFarAway;
  }

  // Distance is only meaningful within one worldspace. Two points in different
  // worldspaces have coordinates that share nothing, so subtracting them
  // produces a number that looks like a distance and means nothing: an
  // interior a few paces from the door can sit at coordinates near the origin
  // and read as tens of thousands of units away, or as none at all.
  //
  // Interiors therefore fall to the default band rather than inheriting the
  // safety of whatever they are standing under. That is a decision rather than
  // a limitation: a dungeon beside the town is still a dungeon.
  uint32_t here = 0;
  try {
    here = actor.GetCellOrWorld().ToFormId(worldState->espmFiles);
  } catch (const std::exception&) {
    return kFarAway;
  }
  if (here != worldState->difficultyHomeWorldOrCellId) {
    return kFarAway;
  }

  // Flat distance, taking x and y and leaving z out. Skyrim is vertical
  // enough that height would distort this badly: somewhere a short walk up a
  // mountainside is a long way away in a straight line, and a player at the
  // bottom of a valley is in no more danger than one standing above them.
  const NiPoint3& pos = actor.GetPos();
  const NiPoint3& home = worldState->difficultyHomePos;
  const float dx = pos.x - home.x;
  const float dy = pos.y - home.y;
  return std::sqrt(dx * dx + dy * dy);
}
