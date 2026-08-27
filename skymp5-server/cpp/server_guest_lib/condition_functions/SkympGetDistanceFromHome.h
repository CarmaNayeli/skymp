#pragma once
#include "ConditionFunction.h"

namespace ConditionFunctions {

// How far this actor is standing from the server's home point, in game units.
//
// Written for difficulty that varies with distance: the ground around the
// place everybody starts should be gentler than the far corners of the map.
// Nothing that existed could express that. Damage multipliers are configured
// by condition, and every stock condition asks about the actor (what they are
// wearing, what race they are, whether they are blocking) rather than about
// where the actor is standing. IsInInterior is the closest, and it answers a
// yes or no about a kind of cell rather than anything about position.
//
// Returns a distance rather than a yes or no, so one function covers as many
// bands as a server wants to write: each entry in damageMultFormulaSettings
// compares it against its own threshold.
class SkympGetDistanceFromHome final : public ConditionFunction
{
public:
  const char* GetName() const override;
  uint16_t GetFunctionIndex() const override;
  float Execute(MpActor& actor, uint32_t parameter1, uint32_t parameter2,
                const ConditionEvaluatorContext& context) override;
};

}
