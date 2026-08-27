#include "DamageMultConditionalFormula.h"

#include "ConditionsEvaluator.h"
#include "MpActor.h"
#include "archives/JsonInputArchive.h"
#include <fmt/format.h>
#include <fmt/ranges.h>
#include <cmath>
#include <functional>
#include <limits>
// Not json_fwd, which is all the header takes: parsing a property's dump below
// needs the definition.
#include <nlohmann/json.hpp>
#include <sstream>

namespace {

// A per actor override of every band below, read off whoever is attacking.
//
// The bands describe a place: how dangerous the world is where the person
// being hit is standing. That is the right default and exactly the wrong
// thing for a creature somebody has put down on purpose, which arrives
// weakened or strengthened by wherever it happened to be dropped rather than
// by any decision. A game master testing whether a bear is survivable cannot
// test it at all if the bear is quietly at 45% for standing near a town.
//
// So one actor may carry a number that REPLACES the bands rather than
// multiplying with them. That is the whole reason this is not simply another
// entry in the config: an override of 1 has to mean full strength, which is
// what somebody typing 1 expects, where multiplying would have handed them
// whatever the band was and called it full.
//
// Left off everybody by default, and the cost of that is one string
// comparison per hit.
const char* kDamageMultOverrideProperty = "private.damageMultOverride";

std::optional<float> ReadDamageMultOverride(const MpActor& aggressor)
{
  const std::string& dump =
    aggressor.GetDynamicFields().GetValueDump(kDamageMultOverrideProperty);

  // What GetValueDump answers for a property nobody has set, which is almost
  // every actor on almost every hit. Checked first and by string compare, so
  // the common case never reaches a JSON parser.
  if (dump.empty() || dump == "null") {
    return std::nullopt;
  }

  try {
    auto parsed = nlohmann::json::parse(dump);
    if (parsed.is_number()) {
      float value = parsed.get<float>();
      // Negative would heal on hit and a non-finite one would poison every
      // number downstream of it. Both fall back to the bands rather than
      // being clamped, because a value this wrong is a mistake to be found
      // rather than a preference to be honoured.
      if (std::isfinite(value) && value >= 0.f) {
        return value;
      }
    }
  } catch (const std::exception&) {
    // Left to the bands. A property that cannot be read is not a reason to
    // stop working out damage.
  }

  return std::nullopt;
}

}

DamageMultConditionalFormula::DamageMultConditionalFormula(
  std::unique_ptr<IDamageFormula> baseFormula_, const nlohmann::json& config,
  const nlohmann::json& conditionsEvaluatorConfig,
  const std::shared_ptr<ConditionFunctionMap>& conditionFunctionMap_)
  : baseFormula(std::move(baseFormula_))
  , settings(std::nullopt)
  , conditionsEvaluatorSettings(nullptr)
  , conditionFunctionMap(conditionFunctionMap_)
{
  if (config.is_object()) {
    settings = ParseConfig(config);
  }

  if (conditionsEvaluatorConfig.is_object()) {
    conditionsEvaluatorSettings =
      std::make_shared<ConditionsEvaluatorSettings>(
        ConditionsEvaluatorSettings::FromJson(conditionsEvaluatorConfig));
  }
}

float DamageMultConditionalFormula::CalculateDamage(
  const MpActor& aggressor, const MpActor& target,
  const HitData& hitData) const
{
  float baseDamage = baseFormula->CalculateDamage(aggressor, target, hitData);

  // Ahead of the settings check as well as the bands, so an override still
  // means something on a server that configured no bands at all.
  if (auto overridden = ReadDamageMultOverride(aggressor)) {
    return baseDamage * *overridden;
  }

  if (!settings) {
    return baseDamage;
  }

  for (auto& pair : settings->entries) {
    auto& key = pair.first;
    auto& value = pair.second;
    if (value.physicalDamageMultiplier.has_value()) {
      auto callback = [&](bool evalRes, std::vector<std::string>& strings) {
        if (evalRes) {
          baseDamage *= *value.physicalDamageMultiplier;
        }

        if (!strings.empty()) {
          if (evalRes) {
            strings.insert(strings.begin(),
                           fmt::format("Damage multiplier: {} (key={})",
                                       *value.physicalDamageMultiplier, key));
          } else {
            strings.insert(
              strings.begin(),
              fmt::format("Damage multiplier: {} (key={}, evalRes=false)", 1.f,
                          key));
          }
        }
      };

      ConditionEvaluatorContext context;
      context.damageSourceFormId = hitData.source;

      ConditionsEvaluator::EvaluateConditions(
        conditionFunctionMap ? *conditionFunctionMap : ConditionFunctionMap(),
        conditionsEvaluatorSettings ? *conditionsEvaluatorSettings
                                    : ConditionsEvaluatorSettings(),
        ConditionsEvaluatorCaller::kDamageMultConditionalFormula,
        value.conditions, aggressor, target, callback, context);
    }
  }

  return baseDamage;
}

float DamageMultConditionalFormula::CalculateDamage(
  const MpActor& aggressor, const MpActor& target,
  const SpellCastData& spellCastData) const
{
  float baseDamage =
    baseFormula->CalculateDamage(aggressor, target, spellCastData);

  // The same override covers spells, so a spawned mage is at the strength it
  // was asked for whichever hand it uses.
  if (auto overridden = ReadDamageMultOverride(aggressor)) {
    return baseDamage * *overridden;
  }

  if (!settings) {
    return baseDamage;
  }

  for (auto& pair : settings->entries) {
    auto& key = pair.first;
    auto& value = pair.second;
    if (value.magicDamageMultiplier.has_value()) {
      auto callback = [&](bool evalRes, std::vector<std::string>& strings) {
        if (evalRes) {
          baseDamage *= *value.magicDamageMultiplier;
        }

        if (!strings.empty()) {
          if (evalRes) {
            strings.insert(strings.begin(),
                           fmt::format("Damage multiplier: {} (key={})",
                                       *value.magicDamageMultiplier, key));
          } else {
            strings.insert(
              strings.begin(),
              fmt::format("Damage multiplier: {} (key={}, evalRes=false)", 1.f,
                          key));
          }
        }
      };

      ConditionEvaluatorContext context;
      context.damageSourceFormId = spellCastData.spell;

      ConditionsEvaluator::EvaluateConditions(
        conditionFunctionMap ? *conditionFunctionMap : ConditionFunctionMap(),
        conditionsEvaluatorSettings ? *conditionsEvaluatorSettings
                                    : ConditionsEvaluatorSettings(),
        ConditionsEvaluatorCaller::kDamageMultConditionalFormula,
        value.conditions, aggressor, target, callback, context);
    }
  }

  return baseDamage;
}

DamageMultConditionalFormulaSettings DamageMultConditionalFormula::ParseConfig(
  const nlohmann::json& config) const
{
  return DamageMultConditionalFormulaSettings::FromJson(config);
}

DamageMultConditionalFormulaSettings
DamageMultConditionalFormulaSettings::FromJson(const nlohmann::json& j)
{
  DamageMultConditionalFormulaSettings res;

  // iterate object
  for (auto it = j.begin(); it != j.end(); ++it) {
    const auto& key = it.key();
    const auto& value = it.value();

    JsonInputArchive ar(value);
    DamageMultConditionalFormulaSettingsValue valueParsed;
    valueParsed.Serialize(ar);

    res.entries.emplace_back(key, valueParsed);
  }

  // validate
  for (auto& [key, value] : res.entries) {
    for (size_t i = 0; i < value.conditions.size(); ++i) {
      auto& condition = value.conditions[i];

      if (condition.comparison != "==" && condition.comparison != "!=" &&
          condition.comparison != ">" && condition.comparison != "<" &&
          condition.comparison != ">=" && condition.comparison != "<=") {
        throw std::runtime_error(fmt::format(
          "Invalid comparison operator: {} (key={}, condition index={})",
          condition.comparison, key, i));
      }

      if (condition.parameter1.empty()) {
        throw std::runtime_error(fmt::format(
          "Empty parameter1 value (key={}, condition index={})", key, i));
      }

      uint32_t parameter1 = 0;

      if (condition.parameter1.find("0x") == 0 ||
          condition.parameter1.find("0X") == 0) {
        std::stringstream ss;
        ss << std::hex << condition.parameter1.substr(2); // Skip "0x"
        ss >> parameter1;
      } else {
        std::stringstream ss(condition.parameter1);
        ss >> parameter1;
      }

      const bool parsingFailed = parameter1 == 0 &&
        condition.parameter1 != "0" && condition.parameter1 != "0x0" &&
        condition.parameter1 != "0X0";
      if (parsingFailed) {
        throw std::runtime_error(fmt::format(
          "Invalid parameter1 value: {} (key={}, condition index={})",
          condition.parameter1, key, i));
      }

      if (condition.logicalOperator != "OR" &&
          condition.logicalOperator != "AND") {
        throw std::runtime_error(fmt::format(
          "Invalid logical operator: {} (key={}, condition index={})",
          condition.logicalOperator, key, i));
      }
    }
  }

  return res;
}
