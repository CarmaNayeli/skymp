#pragma once
#include "PropertyBinding.h"

class ActiveMagicEffectsBinding : public PropertyBinding
{
public:
  std::string GetPropertyName() const override { return "activeMagicEffects"; }
  Napi::Value Get(Napi::Env env, ScampServer& scampServer,
                  uint32_t formId) override;
};
