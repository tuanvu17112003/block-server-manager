from pathlib import Path
import struct
p=Path(".workflow/artifacts/investigation/prominence-2-v4.0.5-iqWrFu7S-tail.bin")
data=p.read_bytes(); total_size=419000630; tail_start=total_size-len(data)
eocd_pos=data.rfind(b"PK\x05\x06")
if eocd_pos<0: raise RuntimeError("EOCD not found")
eocd=struct.unpack_from("<4s4H2LH",data,eocd_pos)
_,disk,cd_disk,n_disk,n_total,cd_size,cd_offset,comment_len=eocd
print("total_size",total_size,"tail_start",tail_start,"cd_offset",cd_offset,"cd_size",cd_size)
if cd_offset<tail_start: raise RuntimeError("central directory starts before fetched tail")
pos=cd_offset-tail_start; stop=pos+cd_size
index_entry=None; matches=[]
while pos<stop:
    r=struct.unpack_from("<4s6H3I5H2I",data,pos)
    if r[0]!=b"PK\x01\x02": raise RuntimeError("bad central dir signature")
    name_len,extra_len,comment_len=r[10],r[11],r[12]
    name=data[pos+46:pos+46+name_len].decode("utf-8","replace")
    if name=="modrinth.index.json": index_entry=(r[4],r[8],r[9],r[16],name_len,extra_len,r[7])
    if any(n in name.lower() for n in ["modmenu","s_lib","simplytooltips","simply_swords_tweaks","forgeconfigscreens"]): matches.append(name)
    pos+=46+name_len+extra_len+comment_len
print("index_entry",index_entry)
print("archive_matches",matches)
