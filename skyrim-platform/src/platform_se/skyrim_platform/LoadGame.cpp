#pragma comment(lib, "shell32.lib")
#include "LoadGame.h"
#include "NullPointerException.h"
#include "PapyrusTESModPlatform.h"
#include "savefile/SFChangeFormNPC.h"
#include "savefile/SFReader.h"
#include "savefile/SFSeekerOfDifferences.h"
#include "savefile/SFWriter.h"

// For the co-save writer below. Not pulled in by the PCH.
#include <cstdint>
#include <fstream>
#include <vector>

namespace fs = std::filesystem;

CMRC_DECLARE(skyrim_plugin_resources);

constexpr auto g_saveFilePrefix = "TESMODPLATFORM-";

class LoadGameEventSink : public RE::BSTEventSink<RE::TESLoadGameEvent>
{
public:
  LoadGameEventSink()
  {
    auto holder = RE::ScriptEventSourceHolder::GetSingleton();
    if (!holder) {
      throw NullPointerException("holder");
    }

    holder->AddEventSink(
      dynamic_cast<RE::BSTEventSink<RE::TESLoadGameEvent>*>(this));
  }

  RE::BSEventNotifyControl ProcessEvent(
    const RE::TESLoadGameEvent* event,
    RE::BSTEventSource<RE::TESLoadGameEvent>* eventSource) override
  {
    std::thread([] {
      // A way to wait 5 seconds game time
      for (int i = 0; i < 50; ++i) {
        auto n = TESModPlatform::GetNumPapyrusUpdates();
        while (n == TESModPlatform::GetNumPapyrusUpdates()) {
          Sleep(20);
        }
        Sleep(80);
      }

      // Allow MoveRefrToPosition again
      TESModPlatform::BlockMoveRefrToPosition(false);

      // Removes our temporary save files
      try {
        std::filesystem::path path = LoadGame::GetPathToMyDocuments() +
          L"\\My Games\\Skyrim Special Edition\\Saves\\";

        for (auto& file : std::filesystem::directory_iterator(path)) {
          if (file.path().filename().generic_string().find(g_saveFilePrefix) !=
              std::string::npos)
            try {
              std::filesystem::remove(file);
            } catch (...) {
              // I have no idea how to handle these exceptions properly
            }
        }
      } catch (...) {
      }
    }).detach();
    return RE::BSEventNotifyControl::kContinue;
  }
};

extern bool g_allowHideMainMenu;

std::shared_ptr<SaveFile_::SaveFile> LoadGame::PrepareSaveFile(
  const char* pathInAssets)
{
  cmrc::file file;
  try {
    file = cmrc::skyrim_plugin_resources::get_filesystem().open(pathInAssets);
  } catch (std::exception& e) {
    auto dir =
      cmrc::skyrim_plugin_resources::get_filesystem().iterate_directory("");
    std::stringstream ss;
    ss << e.what() << std::endl << std::endl;
    ss << "Root directory contents is: " << std::endl;
    for (auto entry : dir) {
      ss << entry.filename() << std::endl;
    }
    throw std::runtime_error(ss.str());
  }
  return SaveFile_::Reader((uint8_t*)(file.begin()), file.size())
    .GetStructure();
}

void LoadGame::Run(std::shared_ptr<SaveFile_::SaveFile> save,
                   const std::array<float, 3>& pos,
                   const std::array<float, 3>& angle, uint32_t cellOrWorld,
                   Time* time, SaveFile_::Weather* _weather,
                   SaveFile_::ChangeFormNPC_* changeFormNPC,
                   std::vector<std::string>* loadOrder)
{
  if (!save) {
    throw std::runtime_error("Bad SaveFile");
  }

  ModifyPluginInfo(save);

  ModifySaveTime(save, time);
  ModifySaveWeather(save, _weather);
  ModifyPlayerFormNPC(save, changeFormNPC);
  ModifyLoadOrder(save, loadOrder);
  ModifyEssStructure(save, pos, angle, cellOrWorld);

  auto name = g_saveFilePrefix + GenerateGuid();
  if (!SaveFile_::Writer(save).CreateSaveFile(GetSaveFullPath(name))) {
    throw std::runtime_error("CreateSaveFile failed");
  }

  // A save the game will load needs the co-save that goes beside it, or the
  // SKSE plugins loaded alongside us are left in the state they were reverted
  // into. See WriteCoSave.
  WriteCoSave(name);

  TESModPlatform::BlockMoveRefrToPosition(true);
  static LoadGameEventSink g_sink;

  if (auto saveLoadManager = RE::BGSSaveLoadManager::GetSingleton()) {
    return saveLoadManager->Load(name.data());
  } else {
    throw NullPointerException("saveLoadManager");
  }
}

fs::path LoadGame::GetSaveFullPath(const std::string& name)
{
  return GetPathToMyDocuments() +
    L"\\My Games\\Skyrim Special Edition\\Saves\\" + StringToWstring(name) +
    L".ess";
}

fs::path LoadGame::GetCoSaveFullPath(const std::string& name)
{
  return GetPathToMyDocuments() +
    L"\\My Games\\Skyrim Special Edition\\Saves\\" + StringToWstring(name) +
    L".skse";
}

/**
 * Writes the .skse co-save beside the .ess this just built.
 *
 * Every load here is a synthetic save: a template is patched with somebody's
 * appearance and position, written out, and handed to the game. Only the .ess
 * was ever written, and SKSE keeps its plugins' per-save data in a companion
 * .skse. With no such file there is nothing for SKSE to read, so it never
 * dispatches its load callback, and every SKSE plugin that was reverted on the
 * way into this load stays reverted for the rest of the session.
 *
 * What that cost: RaceMenu's character creation with none of RaceMenu in it.
 * Sculpting, warpaint, tints, body paint and the light toggle all dead, while
 * everything anybody thought to check said the mod was fine. The plugin
 * loaded, skee64.dll loaded, and NiOverride answered when called, because
 * those are global Papyrus natives and a revert does not touch them. Only the
 * state skee64 keeps per save was gone, and that is most of the mod.
 *
 * skee64's own log is where the two halves show:
 *
 *   working:  NetImmerse Override Enabled / Saving... / Reverting... /
 *             Loading... / SKEE64Serialization_Load - Loaded
 *   here:     NetImmerse Override Enabled / Reverting...  and nothing more
 *
 * A fresh start is fine because it never reverts in the first place. Only a
 * load does that, and only a load can undo it.
 *
 * The block written is deliberately empty rather than reconstructed. It says
 * "skee64, here is your data, there is none of it", which is all that is
 * needed to bring it back out of the revert; the server pushes the character's
 * real morphs and overlays afterwards. The bytes are the ones a real co-save
 * carries for an untouched character, read out of one rather than guessed:
 * a string table of length zero and an item table of length zero.
 */
void LoadGame::WriteCoSave(const std::string& name)
{
  // SKSE's own header. formatVersion is 1; the two version words are what
  // this build of SKSE and this runtime report, and are informational to the
  // reader rather than a gate, so a mismatch degrades to a warning.
  constexpr uint32_t kFormatVersion = 1;
  constexpr uint32_t kSkseVersion = 0x02020060;  // 2.2.6
  constexpr uint32_t kRuntimeVersion = 0x01064920; // 1.6.1170

  // Signatures and chunk types are four characters written as a little endian
  // uint32, so the value spells the name backwards from how the bytes land.
  // These were read out of a real co-save rather than worked out, because
  // working them out got two of the three the wrong way round.
  constexpr uint32_t kSigSkee = 0x534b4545;         // "EEKS" on disk, skee64
  constexpr uint32_t kChunkStringTable = 0x53545442; // "BTTS" on disk
  constexpr uint32_t kChunkItemData = 0x49544545;    // "EETI" on disk

  std::vector<uint8_t> out;
  auto put32 = [&out](uint32_t v) {
    out.push_back(static_cast<uint8_t>(v & 0xff));
    out.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
    out.push_back(static_cast<uint8_t>((v >> 16) & 0xff));
    out.push_back(static_cast<uint8_t>((v >> 24) & 0xff));
  };

  out.push_back('S');
  out.push_back('K');
  out.push_back('S');
  out.push_back('E');
  put32(kFormatVersion);
  put32(kSkseVersion);
  put32(kRuntimeVersion);
  put32(1); // one plugin: skee64

  // Chunk headers are twelve bytes each, so two empty-ish chunks come to
  // 12 + 4 + 12 + 8.
  constexpr uint32_t kSkeeBlockLength = 36;
  put32(kSigSkee);
  put32(2); // chunk count
  put32(kSkeeBlockLength);

  put32(kChunkStringTable);
  put32(3); // version, as written by skee64 for this chunk
  put32(4);
  put32(0); // no strings

  put32(kChunkItemData);
  put32(2); // version, as written by skee64 for this chunk
  put32(8);
  put32(1); // the table's own version
  put32(0); // no items

  try {
    std::ofstream f(GetCoSaveFullPath(name), std::ios::binary);
    f.write(reinterpret_cast<const char*>(out.data()), out.size());
  } catch (const std::exception& e) {
    // Not fatal, and not silent. Without the co-save the load still happens
    // and the session is playable, it is only the SKSE plugins that stay
    // reverted, which is the state this exists to leave behind.
    logger::error("failed to write co-save for {}: {}", name, e.what());
  }
}

std::wstring LoadGame::GetPathToMyDocuments()
{
  PWSTR ppszPath;
  HRESULT hr = SHGetKnownFolderPath(FOLDERID_Documents, 0, NULL, &ppszPath);
  std::wstring myPath;
  if (SUCCEEDED(hr)) {
    myPath = ppszPath;
  }
  CoTaskMemFree(ppszPath);
  return myPath;
}

void LoadGame::ModifyPluginInfo(std::shared_ptr<SaveFile_::SaveFile>& save)
{
  std::vector<std::string> newPlugins;
  auto dataHandler = RE::TESDataHandler::GetSingleton();

  if (!dataHandler) {
    throw NullPointerException("dataHandler");
  }

  for (auto& file : dataHandler->files) {
    newPlugins.push_back(std::string(file->fileName));
  }

  save->OverwritePluginInfo(newPlugins);
}

void LoadGame::ModifySaveTime(std::shared_ptr<SaveFile_::SaveFile>& save,
                              LoadGame::Time* time)
{
  if (!time) {
    return;
  }

  if (!time->IsSet()) {
    throw std::runtime_error("Time data is not filled");
  }

  SaveFile_::RefID gameHourID = 0x38;

  auto index = save->FindIndexInFormIdArray(0x38);
  if (index >= 0) {
    gameHourID = SaveFile_::RefID(static_cast<uint32_t>(index));
  }

  auto var = save->GetGlobalvariableByRefID(gameHourID);
  if (!var) {
    throw std::runtime_error("Global Varible not found");
  }

  var->value =
    time->GetHours() + time->GetMinutes() / 60.0 + time->GetSeconds() / 3600.0;
}

void LoadGame::ModifySaveWeather(std::shared_ptr<SaveFile_::SaveFile>& save,
                                 SaveFile_::Weather* _weather)
{
  if (!_weather) {
    return;
  }

  SaveFile_::GlobalData& gData =
    save->globalDataTable1[SaveFile_::SaveFile::WEATHER_INDEX];

  if (gData.type != SaveFile_::SaveFile::WEATHER_INDEX) {
    throw std::runtime_error("Wrong weather index");
  }

  SaveFile_::Weather* weather =
    reinterpret_cast<SaveFile_::Weather*>(gData.data.get());

  if (!weather) {
    throw NullPointerException("weather");
  }

  weather->climate = _weather->climate;
  weather->weather = _weather->weather;
  weather->regnWeather = _weather->regnWeather;
  weather->weatherPct = _weather->weatherPct;
}

void LoadGame::ModifyPlayerFormNPC(std::shared_ptr<SaveFile_::SaveFile> save,
                                   SaveFile_::ChangeFormNPC_* changeFormNPC)
{
  using namespace SaveFile_;
  if (!changeFormNPC) {
    return;
  }

  auto form = save->GetChangeFormByRefID(RefID(RefID::PlayerBase),
                                         uint8_t(ChangeForm::Type::NPC));

  if (form) {
    auto newForm = changeFormNPC->ToBinary();
    FillChangeForm(save, form, newForm);
  }
}

void LoadGame::ModifyLoadOrder(std::shared_ptr<SaveFile_::SaveFile> save,
                               std::vector<std::string>* loadOrder)
{
  if (loadOrder) {
    save->OverwritePluginInfo(*loadOrder);
  }
}

void LoadGame::FillChangeForm(
  std::shared_ptr<SaveFile_::SaveFile> save, SaveFile_::ChangeForm* form,
  std::pair<uint32_t, std::vector<uint8_t>>& newValues)
{

  save->fileLocationTable.formIDArrayCountOffset -= form->length1;
  save->fileLocationTable.formIDArrayCountOffset += newValues.second.size();

  save->fileLocationTable.unknownTable3Offset -= form->length1;
  save->fileLocationTable.unknownTable3Offset += newValues.second.size();

  save->fileLocationTable.globalDataTable3Offset -= form->length1;
  save->fileLocationTable.globalDataTable3Offset += newValues.second.size();

  form->length2 = 0;
  form->length1 = newValues.second.size();
  form->data = newValues.second;
  form->changeFlags = newValues.first;
}

void LoadGame::ModifyEssStructure(std::shared_ptr<SaveFile_::SaveFile> save,
                                  std::array<float, 3> pos,
                                  std::array<float, 3> angle,
                                  uint32_t cellOrWorld)
{
  auto playerLoc = FindSectionWithPlayerLocation(save);
  if (!playerLoc) {
    throw std::runtime_error("Couldn't find PlayerLocation in the save file");
  }

  auto worldRefId = SaveFile_::RefID::CreateRefId(*save, cellOrWorld);
  *playerLoc = CreatePlayerLocation(pos, worldRefId);

  auto player = std::find_if(
    save->changeForms.begin(), save->changeForms.end(),
    [](auto& changeForm) { return changeForm.formID.IsPlayerID(); });
  if (player == save->changeForms.end()) {
    throw std::runtime_error("Unable to find Player's change form");
  }
  bool isCompressed = player->length2 > 0;
  if (!isCompressed) {
    throw std::runtime_error("Player's ChangeForm must be compressed");
  }

  auto uncompressed = Decompress(*player);
  EditChangeForm(uncompressed, pos, angle, worldRefId);
  auto compressed = Compress(uncompressed);
  WriteChangeForm(save, *player, compressed, uncompressed.size());
}

SaveFile_::PlayerLocation* LoadGame::FindSectionWithPlayerLocation(
  std::shared_ptr<SaveFile_::SaveFile> save)
{
  auto& c = save->globalDataTable1;
  auto it = std::find_if(
    c.begin(), c.end(), [](const SaveFile_::GlobalData& globalData) {
      return globalData.type == SaveFile_::PlayerLocation::GlobalDataType;
    });
  if (it == c.end()) {
    return nullptr;
  }
  return static_cast<SaveFile_::PlayerLocation*>(it->data.get());
}

SaveFile_::PlayerLocation LoadGame::CreatePlayerLocation(
  const std::array<float, 3>& pos, const SaveFile_::RefID& world)
{
  SaveFile_::PlayerLocation r;
  r.nextObjectId = 0xFF0014FE;
  r.worldspace1 = world;
  r.coorX = static_cast<int>(pos[0]) / 4096;
  r.coorY = static_cast<int>(pos[1]) / 4096;
  r.worldspace2 = world;
  r.posX = pos[0];
  r.posY = pos[1];
  r.posZ = pos[2];
  r.unknown = 0;
  return r;
}

std::vector<uint8_t> LoadGame::Decompress(
  const SaveFile_::ChangeForm& changeForm)
{
  const size_t lengthCompressed = changeForm.length1;
  const size_t lengthUncompressed = changeForm.length2;
  auto uncompressed = (std::vector<uint8_t>(lengthUncompressed));
  const auto compressed = changeForm.data.data();
  SaveFile_::SeekerOfDifferences::ZlibDecompress(
    compressed, lengthCompressed, uncompressed.data(), lengthUncompressed);
  return uncompressed;
}

void LoadGame::EditChangeForm(std::vector<uint8_t>& data,
                              const std::array<float, 3>& pos,
                              const std::array<float, 3>& angle,
                              const SaveFile_::RefID& world)
{
  auto d = data.data();
  *reinterpret_cast<SaveFile_::RefID*>(d + 0) = world;

  auto& changeFormPos = *reinterpret_cast<std::array<float, 3>*>(d + 3);
  changeFormPos = pos;

  float* changeFormAngle = reinterpret_cast<float*>(d + 15);
  for (int i = 0; i < 3; ++i) {
    changeFormAngle[i] = angle[i] / 180.f * acos(-1);
  }
}

std::vector<uint8_t> LoadGame::Compress(
  const std::vector<uint8_t>& uncompressed)
{
  size_t newCompressedSizeMax = uncompressed.size();
  std::vector<uint8_t> newCompressed(newCompressedSizeMax, 0);
  const auto newCompressedSize = SaveFile_::SeekerOfDifferences::ZlibCompress(
    uncompressed.data(), uncompressed.size(), newCompressed.data(),
    newCompressedSizeMax);
  newCompressed.resize(newCompressedSize);
  return newCompressed;
}

void LoadGame::WriteChangeForm(std::shared_ptr<SaveFile_::SaveFile> save,
                               SaveFile_::ChangeForm& changeForm,
                               const std::vector<uint8_t>& compressed,
                               size_t uncompressedSize)
{
  auto previousSize = changeForm.length1;

  changeForm.length1 = compressed.size();
  changeForm.length2 = uncompressedSize;
  changeForm.data.resize(changeForm.length1);
  std::copy(compressed.begin(), compressed.end(), changeForm.data.begin());

  // fix offsets
  const auto diff = static_cast<int64_t>(previousSize) -
    static_cast<int64_t>(compressed.size());
  save->fileLocationTable.formIDArrayCountOffset -= diff;
  save->fileLocationTable.unknownTable3Offset -= diff;
  save->fileLocationTable.globalDataTable3Offset -= diff;
}

std::wstring LoadGame::StringToWstring(const std::string& s)
{
  std::wstring ws(s.size(), L' ');
  auto n = std::mbstowcs(&ws[0], s.c_str(), s.size());
  ws.resize(n);
  return ws;
}

std::string LoadGame::GenerateGuid()
{
  GUID guid;
  if (CoCreateGuid(&guid) != S_OK) {
    throw std::runtime_error("CoCreateGuid failed");
  }

  char name[37] = { 0 }; // Size adjusted for GUID string
  sprintf_s(
    name,
    "%08lX-%04hX-%04hX-%02hhX%02hhX-%02hhX%02hhX%02hhX%02hhX%02hhX%02hhX",
    guid.Data1, guid.Data2, guid.Data3, guid.Data4[0], guid.Data4[1],
    guid.Data4[2], guid.Data4[3], guid.Data4[4], guid.Data4[5], guid.Data4[6],
    guid.Data4[7]);
  return name;
}
