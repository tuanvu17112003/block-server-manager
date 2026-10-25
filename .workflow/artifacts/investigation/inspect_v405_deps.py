from pathlib import Path
import json,struct,zlib
p=Path(".workflow/artifacts/investigation/prominence-2-v4.0.5-iqWrFu7S-index-range.bin")
data=p.read_bytes(); h=struct.unpack_from("<4s5H3I2H",data,0)
name_len,extra_len=h[-2],h[-1]; raw=zlib.decompress(data[30+name_len+extra_len:30+name_len+extra_len+87861],-15); idx=json.loads(raw)
needles=("modmenu","s_lib","s-lib","slib","simplytooltips","forgeconfigscreens","simply_swords_tweaks","mutant_skeleton_armor_tweaks","quests_teams_fixes","unrestricted_enchanting")
for entry in idx.get("files",[]):
 p=entry.get("path","")
 if any(s in p.lower() for s in needles):
  print(json.dumps({"path":p,"env":entry.get("env"),"size":entry.get("fileSize"),"downloads":entry.get("downloads")},ensure_ascii=False))
