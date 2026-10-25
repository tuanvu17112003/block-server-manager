from pathlib import Path
import json,struct,zlib
p=Path(".workflow/artifacts/investigation/prominence-2-v4.1.1hf-index-range.bin")
data=p.read_bytes(); h=struct.unpack_from("<4s5H3I2H",data,0)
sig,ver,flags,method,mt,md,lc,ls,lu,nl,el=h
if sig!=b"PK\x03\x04" or method!=8: raise RuntimeError("unexpected local header")
start=30+nl+el; comp=data[start:start+86861]
if len(comp)!=86861: raise RuntimeError(f"short index range: {len(comp)}")
raw=zlib.decompress(comp,-15)
if len(raw)!=305025 or (zlib.crc32(raw)&0xffffffff)!=0x7d938668: raise RuntimeError("index checksum mismatch")
idx=json.loads(raw)
print("pack",idx.get("name"),"versionId",idx.get("versionId"),"files",len(idx.get("files",[])))
needles=("modmenu","s_lib","s-lib","slib","simplytooltips","forgeconfigscreens","simply_swords_tweaks","mutant_skeleton_armor_tweaks","quests_teams_fixes","unrestricted_enchanting","simplyswords","simplybows")
for entry in idx.get("files",[]):
 path=entry.get("path","")
 if any(s in path.lower() for s in needles):
  print(json.dumps({"path":path,"env":entry.get("env"),"size":entry.get("fileSize"),"downloads":entry.get("downloads")},ensure_ascii=False))
