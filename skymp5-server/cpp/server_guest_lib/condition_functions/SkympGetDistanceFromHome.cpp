#include "SkympGetDistanceFromHome.h"
#include "MpActor.h"
#include "MpObjectReference.h"
#include "WorldState.h"
#include <cmath>
#include <limits>
#include <nlohmann/json.hpp>

namespace {
// Where this actor last stood on ground this function could measure.
//
// Written by the gamemode, read here, and private so it never leaves the
// server. Named for what it is rather than for Hearthheld, because any server
// that configures a home point wants its interiors to belong somewhere.
const char* kAnchorProperty = "private.difficultyAnchor";
}

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
    // Somewhere this cannot measure, which is every interior and every other
    // worldspace. An anchor stands in for it if one has been left.
    //
    // Without one an interior falls to the default, and that was wrong in a
    // way worth spelling out: a cellar under a house in town became exactly as
    // dangerous as a cave at the edge of the map, because both are simply
    // "not measurable from here". Every bandit hideout in the province sat at
    // the same difficulty regardless of where its door was.
    //
    // The anchor is the last distance this actor was measured at while it was
    // somewhere this function could measure, written by the gamemode. For an
    // interior that is the doorstep, because the last outdoor ground anybody
    // stands on before going in is the ground the door is on. So an interior
    // inherits the band of its door, which is what a place a short walk from
    // home should feel like whether the roof is over it or not.
    //
    // Costs one string comparison per hit for anybody standing outdoors, and
    // is only read at all when the position cannot be used directly.
    const std::string& anchor =
      actor.GetDynamicFields().GetValueDump(kAnchorProperty);
    if (anchor.empty() || anchor == "null") {
      return kFarAway;
    }
    try {
      auto parsed = nlohmann::json::parse(anchor);
      if (parsed.is_number()) {
        float value = parsed.get<float>();
        if (std::isfinite(value) && value >= 0.f) {
          return value;
        }
      }
    } catch (const std::exception&) {
      // Unreadable is the same as absent: fall to the default rather than
      // guessing at a number that decides how hard somebody is hit.
    }
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
