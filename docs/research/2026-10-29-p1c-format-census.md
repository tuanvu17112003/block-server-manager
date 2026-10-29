# P1c census: archive formats (measured from primary sources, before writing any parser)

- Date: 2026-10-29
- Discipline applied: **census first, code second** (the lesson from [18](18-systematic-verification-census.md)).
- Method: read the **serializer** in each project's own source (cloned at the commits below), not docs and not
  guesses. Field names, value-space and detection keys below are quoted from code.

Repos and commits:

| Project | Commit |
|---|---|
| PrismLauncher/PrismLauncher | `181408813f46367ee8f709194424292bb355bbaf` |
| ATLauncher/ATLauncher | `8e9a71345bf35aee4e927a848930e946de331b30` |
| packwiz/packwiz | `170b22d785959dda5876b54b7f16e1b807a57fb6` |

---

## 1. Prism / MultiMC — `mmc-pack.json`

**Serializer**: `launcher/minecraft/PackProfile.cpp`.

```cpp
static const int currentComponentsFileVersion = 1;   // L104
...
obj.insert("formatVersion", currentComponentsFileVersion);   // L164
obj.insert("components", orderArray);                        // L169
// per component (componentToJsonV1, L106-135):
obj.insert("uid", component->m_uid);                          // L110
obj.insert("version", component->m_version);                  // L112
obj.insert("dependencyOnly", true);                           // L115  (only when set)
obj.insert("important", true);                                // L118  (only when set)
obj.insert("cachedName", component->m_cachedName);            // L129  (only when non-empty)
obj.insert("cachedVolatile", true);                           // L134  (only when set)
```

Reader requires (`componentFromJsonV1` L139-151, and the file loader L207-211):
`uid` **string required**, `version` string, `formatVersion` **integer required** and must equal `1`,
`components` **array required**.

**Component UIDs that carry the runtime** (from `Component.cpp`, the ModPlatform mapping):

| uid | meaning |
|---|---|
| `net.minecraft` | the Minecraft version (the value is the MC version) |
| `net.minecraftforge` | Forge, value = Forge build |
| `net.neoforged` | NeoForge |
| `net.fabricmc.fabric-loader` | Fabric loader, value = loader build |
| `org.quiltmc.quilt-loader` | Quilt loader |

`Component.cpp` also lists these five as mutually exclusive, so a pack carrying two of them is contradictory.

**Detection keys (validated, not just filename):** `mmc-pack.json` present **and** parses to an object with
`formatVersion === 1` (integer) **and** `components` is an array whose entries have `uid` + `version` **and**
one entry's `uid === 'net.minecraft'`.

**Important limit measured from source:** Prism has **no server export** (only zip / `.mrpack` / CurseForge
pack — `MainWindow.cpp` L225-227, 0 hits for `ServerPack`). So an `mmc-pack.json` archive is a *client
instance*; converting it to a server means resolving loader + MC from components and taking the client
instance's `.minecraft` payload as overrides. That is inference, and it must be reported as such.

---

## 2. ATLauncher — `instance.json`

**Serializer**: `data/Instance.java` — the whole `Instance` object is written with Gson (`@Json` class),
`save()` at L1994-2001 writes `instance.json`.

Top-level public fields (L~175-200):

```java
public UUID uuid;
public String inheritsFrom;
public InstanceLauncher launcher;
public transient Path ROOT;        // not serialized
```

`InstanceLauncher` (`data/InstanceLauncher.java`) carries the pack identity and runtime:

```java
public String name;                  // pack display name
public String pack;                  // pack "type"/source classification
public String description;
public Integer packId;
@SerializedName(value="externalPackId", alternate={"externaPackId"}) public Integer externalPackId;
public String version;               // pack version
public String hash;
public Java java;                    // java selection block
@SerializedName(value="enableCurseForgeIntegration", alternate={"enableCurseIntegration"}) public boolean enableCurseForgeIntegration;
public LoaderVersion loaderVersion;  // loader family + version
public Integer requiredMemory; public Integer requiredPermGen;
public Integer maximumMemory; public Integer permGen;
public String javaPath; public String javaArguments; public String javaRuntimeOverride;
public QuickPlay quickPlay; public Boolean useJavaProvidedByMinecraft;
public Boolean disableLegacyLaunching; public Boolean enableCommands;
public String preLaunchCommand; public String postExitCommand; public String wrapperCommand;
public Boolean useSystemGlfw; public Boolean useSystemOpenAl;
public boolean isDev; public boolean isPlayable; public boolean assetsMapToResources;
public CurseForgeManifest curseForgeManifest;   // present for CF-sourced packs
```

**Detection keys:** `instance.json` present **and** parses with `uuid` **or** `launcher` object present **and**
the `launcher` object contains at least `name` or `pack`. This is what distinguishes it from FTB's
`instance.json` (which has `uuid`, `id`, `versionId`, `mcVersion`, `modLoader`) and from Minecraft's own
launcher profile (which has a `profiles` object, not `launcher`).

**Critical ambiguity measured:** *three* formats write a file literally named `instance.json`:
ATLauncher (`uuid` + `launcher`), FTB App (`id`/`versionId`/`mcVersion`/`modLoader`), and Minecraft's own
launcher (`profiles`). Filename alone is worthless — key validation is mandatory.

---

## 3. packwiz — `pack.toml` + `index.toml` + `*.pw.toml`

**Serializer**: `core/pack.go`, `core/index.go`, `core/indexfiles.go`, `core/mod.go`.

`pack.toml` (`Modpack` struct, `pack.go`):

```go
Name        string `toml:"name"`
Author      string `toml:"author,omitempty"`
Version     string `toml:"version,omitempty"`
Description string `toml:"description,omitempty"`
PackFormat  string `toml:"pack-format"`          // "packwiz:1.1.0" (CurrentPackFormat)
File        string `toml:"file"`                 // inside [index]
HashFormat  string `toml:"hash-format"`          // inside [index]
Hash        string `toml:"hash,omitempty"`       // inside [index]
Versions map[string]string                 `toml:"versions"`   // e.g. minecraft/fabric/forge/quilt
Export   map[string]map[string]interface{} `toml:"export"`
Options  map[string]interface{}            `toml:"options"`
```

`CurrentPackFormat = "packwiz:1.1.0"`; `1.0.0` is auto-migrated, and a missing `pack-format` is **assumed** to
be `1.1.0` (`pack.go` L57-58) — so detection must not require the field.

`index.toml` (`IndexFile`):

```go
HashFormat string `toml:"hash-format"`
Files      indexFilesTomlRepresentation `toml:"files"`
// each entry (indexfiles.go):
File       string `toml:"file"`
Hash       string `toml:"hash,omitempty"`
HashFormat string `toml:"hash-format,omitempty"`
Alias      string `toml:"alias,omitempty"`
MetaFile   bool   `toml:"metafile,omitempty"`
Preserve   bool   `toml:"preserve,omitempty"`
```

`*.pw.toml` mod metafile (`Mod` struct, `mod.go`):

```go
Name     string      `toml:"name"`
FileName string      `toml:"filename"`
Side     string      `toml:"side,omitempty"`     // "both" | "client" | "server"; empty ≡ both
Pin      bool        `toml:"pin,omitempty"`
Download ModDownload `toml:"download"`           // url / hash-format / hash / mode
Update     map[string]map[string]interface{} `toml:"update"`
Option *ModOption `toml:"option,omitempty"`      // optional/default/description
URL        string `toml:"url,omitempty"`
HashFormat string `toml:"hash-format"`
Hash       string `toml:"hash"`
```

Side constants (`mod.go` L52-54): `ServerSide = "server"`, `ClientSide = "client"`,
`UniversalSide = "both"`.

**Detection keys:** `pack.toml` present **and** parses as TOML with a `versions` table containing `minecraft`
**and** either `pack-format` starting with `packwiz:` or an `[index]` table with `file`+`hash-format`.
`pack.toml` is a generic filename (Rust/Cargo uses it too), so the `versions.minecraft` key is the real signal.

**Measured limitation:** packwiz is a *declarative* format. `pack.toml` alone carries **no file list** — the
files live in `index.toml`, and per-mod sides live in each `*.pw.toml`. A packwiz archive without
`index.toml` cannot be installed by us; that must fail with a specific reason, not a generic error.

---

## 4. Plain server zip (no manifest at all)

Observed shapes from the earlier CurseForge work (real archives, see doc 11/12): a zip containing
`mods/`, `config/`, optionally `libraries/`, `run.sh`/`run.bat`/`startserver.sh`, `user_jvm_args.txt`, or a
`forge-*-installer.jar`. No machine-readable pack metadata.

**Detection:** last resort, only when every other adapter declines: the archive has a top-level `mods/`
directory **or** a loader installer jar at root **or** `libraries/` + run scripts. MC version and loader are
then derived from evidence in this order: `version.json`/`META-INF/MANIFEST.MF` in a bundled server jar →
`libraries/net/minecraftforge/forge/<mc>-<build>/` maven path → installer jar filename. If none of those yields
an exact MC version, the adapter must **fail closed** — a bare `mods/` dump with no version evidence cannot be
installed safely.

---

## 5. Detection priority (derived from the above, not from filenames)

| Priority | Format | Decisive validated key |
|---|---|---|
| 90 | `modrinth.mrpack` | `modrinth.index.json` with `formatVersion === 1` + `game === "minecraft"` |
| 85 | `curseforge.client` | `manifest.json` with `manifestType === "minecraftModpack"` + `manifestVersion === 1` |
| 80 | `hmcl.server` | `server-manifest.json` |
| 70 | `mcbbs` | `mcbbs.packmeta` |
| 60 | `packwiz` | `pack.toml` with `versions.minecraft` (+ `pack-format` prefix or `[index]`) |
| 55 | `prism.multimc` | `mmc-pack.json` with `formatVersion===1` + `components[]` incl. `net.minecraft` |
| 50 | `atlauncher` | `instance.json` with `launcher` object + (`uuid` or launcher name) |
| 45 | `ftb.app` | `instance.json` with numeric `id` **and** `versionId` **and** `mcVersion` |
| 20 | `plain.serverzip` | top-level `mods/` or loader installer/libraries, when nothing else matched |

`instance.json` appears three times in that table — which is exactly why each detector validates keys instead
of trusting the filename.

## 6. Scope decision for this phase

Implement, in this order of risk: **packwiz**, **prism.multimc**, **atlauncher**, **plain.serverzip**, plus a
`curseforge.serverpack`/bare-zip discriminator that reuses the existing CurseForge inspector rather than
duplicating it. HMCL/MCBBS/GDLauncher/Technic are catalogued above but deferred — they need their own census
(their manifests were not read at source in this pass, and inventing their key sets is exactly the mistake this
document exists to prevent).
