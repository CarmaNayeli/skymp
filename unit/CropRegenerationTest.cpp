#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>
#include <chrono>

#include "CropRegeneration.h"
#include "GetBaseActorValues.h"
#include "libespm/Loader.h"

PartOne& GetPartOne();
extern espm::Loader l;

TEST_CASE("CropRegeneration function is working correctly",
          "[CropRegeneration]")
{
  float secondsAfterLastRegen = 1.0f;
  float attributeRate = 0.7f;
  float attributeRateMult = 100.0f;
  float oldAttributeValue = 0.6f;

  float validAttributeValueRegeneration = attributeRate / 100.0f *
    attributeRateMult / 100.0f * secondsAfterLastRegen;

  float newAttributeValue =
    oldAttributeValue + validAttributeValueRegeneration;

  REQUIRE(CropRegeneration(newAttributeValue, 1.0f, 0.7f, 100.0f, 0.6f,
                           false) == newAttributeValue);
}

TEST_CASE("CropRegeneration keeps a rise the client reports even when "
          "regeneration alone could not have managed it",
          "[CropRegeneration]")
{
  // This used to return oldAttributeValue, on the grounds that a client
  // cannot regenerate faster than its rate allows. True, and beside the
  // point: a healing spell is not regeneration, and clipping it to what
  // regeneration allows is what made every heal snap back.
  float oldAttributeValue = 0.6f;

  float newAttributeValue = oldAttributeValue + 0.007f;

  REQUIRE(CropRegeneration(newAttributeValue, 1.0f, 0.7f, -100.0f,
                           oldAttributeValue, false) == newAttributeValue);
}

TEST_CASE(
  "CropRegeneration returns 1 if regeneration is enough to restore attribute",
  "[CropRegeneration]")
{
  REQUIRE(CropRegeneration(1.0f, 1.0f, 5.0f, 100.0f, 0.97f, false) == 1.0f);
}

TEST_CASE("CropRegeneration returns 1 if newAttributeValue is more then 1 "
          "when oldAttributeValue = 1",
          "[CropRegeneration]")
{
  REQUIRE(CropRegeneration(1.05f, 1.0f, 5.0f, 100.0f, 1.0f, false) == 1.0f);
}

TEST_CASE("CropRegeneration lets somebody go from nothing to full, because a "
          "spell can do that",
          "[CropRegeneration]")
{
  // Formerly 0.05f, which is what a second of regeneration is worth from
  // nothing. Somebody healed off the floor is the exact case this broke.
  REQUIRE(CropRegeneration(1.0f, 1.0f, 5.0f, 100.0f, 0.0f, false) == 1.0f);
}

TEST_CASE("CropPeriodAfterLastRegen returns 0 if period < 0",
          "[CropRegeneration]")
{
  REQUIRE(CropPeriodAfterLastRegen(-1.0f) == 0.0f);
}

TEST_CASE(
  "CropPeriodAfterLastRegen returns defaultPeriod if period > maxValidPeriod",
  "[CropRegeneration]")
{
  float defaultPeriod = 1.0f;
  float maxValidPeriod = 2.0f;
  REQUIRE(CropPeriodAfterLastRegen(2.5f, maxValidPeriod, defaultPeriod) ==
          1.0f);
}

TEST_CASE("CropPeriodAfterLastRegen returns correct value if period is in "
          "0...maxValidPeriod interval",
          "[CropRegeneration]")
{
  float defaultPeriod = 1.0f;
  float maxValidPeriod = 2.0f;
  REQUIRE(CropPeriodAfterLastRegen(1.3f, maxValidPeriod, defaultPeriod) ==
          1.3f);
}

TEST_CASE("CropHealthRegeneration, CropMagickaRegeneration and "
          "CropStaminaRegeneration are working correctly, regeneration is not "
          "too fast",
          "[CropRegeneration]")
{

  using namespace std::chrono_literals;

  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  // The rates were read here to work out what a second of regeneration comes
  // to. Nothing needs that now: what comes back is what was reported.
  ac.SetPercentages({ 0.0f, 0.0f, 0.0f });

  auto past = std::chrono::steady_clock::now();
  auto now = past + 1s;
  ac.SetLastAttributesPercentagesUpdate(past);
  std::chrono::duration<float> timeDuration = now - past;
  float time = timeDuration.count();

  // All three used to come back as one second of natural regeneration from
  // zero, whatever the client said. They now come back as what the client
  // said, bounded to one: a potion, a shrine and a healing spell all look
  // exactly like this from here, and none of them is regeneration.
  REQUIRE_THAT(CropHealthRegeneration(1.0f, time, &ac),
               Catch::Matchers::WithinAbs(1.0f, 0.000001f));
  REQUIRE_THAT(CropMagickaRegeneration(1.0f, time, &ac),
               Catch::Matchers::WithinAbs(1.0f, 0.000001f));
  REQUIRE_THAT(CropStaminaRegeneration(1.0f, time, &ac),
               Catch::Matchers::WithinAbs(1.0f, 0.000001f));

  // And a drop is still a drop, which is what keeps damage and death working.
  REQUIRE_THAT(CropHealthRegeneration(0.25f, time, &ac),
               Catch::Matchers::WithinAbs(0.25f, 0.000001f));
  REQUIRE_THAT(CropHealthRegeneration(-1.0f, time, &ac),
               Catch::Matchers::WithinAbs(0.0f, 0.000001f));

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}
