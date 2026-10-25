from pathlib import Path
import json,struct,zlib
p=Path(".workflow/artifacts/investigation/prominence-2-v4.1.3-index-range.bin"); d=p.read_bytes(); h=struct.unpack_from("<4s5H3I2H",d,0)
sig,ver,flags,method,mt,md,crc,cs,us,nl,xl=h
if sig!=b"PK\x03\x04" or method!=8: raise RuntimeError("bad local header")
raw=zlib.decompress(d[30+nl+xl:30+nl+xl+88135],-15)
if len(raw)!=309520 or (zlib.crc32(raw)&0xffffffff)!=0x03667b7b: raise RuntimeError("index checksum mismatch")
idx=json.loads(raw); print("pack",idx.get("name"),"versionId",idx.get("versionId"),"files",len(idx.get("files",[])))
needles=("modmenu","s_lib","s-lib","slib","simplytooltips","forgeconfigscreens","simply_swords_tweaks","mutant_skeleton_armor_tweaks","quests_teams_fixes","unrestricted_enchanting","simplyswords","simplybows")
for e in idx.get("files",[]):
 path=e.get("path","")
 if any(s in path.lower() for s in needles):
  print(json.dumps({"path":path,"env":e.get("env"),"size":e.get("fileSize"),"downloads":e.get("downloads")},ensure_ascii=False))
