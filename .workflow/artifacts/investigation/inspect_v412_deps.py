from pathlib import Path
import json,struct,zlib
p=Path(".workflow/artifacts/investigation/prominence-2-v4.1.2-index-range.bin")
data=p.read_bytes(); h=struct.unpack_from("<4s5H3I2H",data,0)
sig,ver,flags,method,mt,md,local_crc,local_comp,local_uncomp,name_len,extra_len=h
if sig!=b"PK\x03\x04" or method!=8: raise RuntimeError("unexpected local header")
start=30+name_len+extra_len
compressed=data[start:start+87972]
if len(compressed)!=87972: raise RuntimeError(f"short compressed index: {len(compressed)}")
raw=zlib.decompress(compressed,-15)
if len(raw)!=308911 or (zlib.crc32(raw)&0xffffffff)!=0x2eb2d4a8: raise RuntimeError("index checksum mismatch")
index=json.loads(raw)
print("pack",index.get("name"),"versionId",index.get("versionId"),"files",len(index.get("files",[])))
needles=("modmenu","s_lib","s-lib","slib","simplytooltips","forgeconfigscreens","simply_swords_tweaks","mutant_skeleton_armor_tweaks","quests_teams_fixes","unrestricted_enchanting","simplyswords","simplybows")
for entry in index.get("files",[]):
    path=entry.get("path","")
    if any(s in path.lower() for s in needles):
        print(json.dumps({"path":path,"env":entry.get("env"),"size":entry.get("fileSize"),"downloads":entry.get("downloads")},ensure_ascii=False))
