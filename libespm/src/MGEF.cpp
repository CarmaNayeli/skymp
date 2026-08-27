#include "libespm/MGEF.h"
#include "libespm/RecordHeaderAccess.h"
#include <cstring>
#include <type_traits>

namespace espm {

MGEF::Data MGEF::GetData(
  CompressedFieldsCache& compressedFieldsCache) const noexcept
{
  Data result;
  RecordHeaderAccess::IterateFields(
    this,
    [&](const char* type, uint32_t size, const char* data) {
      if (!std::memcmp(type, "CTDA", 4)) {
        // A condition is 32 bytes, and the function it asks is a uint16 eight
        // bytes in. 448 is HasPerk. Nothing else in the condition is read,
        // because nothing else here could answer it.
        constexpr uint32_t kConditionSize = 32;
        constexpr uint32_t kFunctionOffset = 8;
        constexpr uint16_t kHasPerk = 448;
        if (size >= kConditionSize) {
          const uint16_t function =
            *reinterpret_cast<const uint16_t*>(data + kFunctionOffset);
          if (function == kHasPerk) {
            result.data.hasPerkCondition = true;
          }
        }
      } else if (!std::memcmp(type, "DATA", 4)) {
        result.data.flags = *reinterpret_cast<const Flags*>(data);
        // Eight bytes in, after the flags and the base cost. Verified
        // against the record itself: the Ebony Mail's cloak effect names
        // DA02PoisonCloakDmg at exactly this offset.
        if (size >= 0x0c) {
          result.data.associatedItemId =
            *reinterpret_cast<const uint32_t*>(data + 0x08);
        }
        result.data.effectType = EffectType{
          *reinterpret_cast<const std::underlying_type_t<EffectType>*>(data +
                                                                       0x40)
        };
        result.data.primaryAV = ActorValue(
          *reinterpret_cast<const std::underlying_type_t<ActorValue>*>(data +
                                                                       0x44));
      }
    },
    compressedFieldsCache);

  return result;
}

}
