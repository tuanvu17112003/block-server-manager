from pathlib import Path
import struct
p=Path(".workflow/artifacts/investigation/prominence-2-v4.1.3-tail.bin")
data=p.read_bytes(); total=423424621; start=total-len(data); e=data.rfind(b"PK\x05\x06")
if e<0: raise RuntimeError("EOCD missing")
rec=struct.unpack_from("<4s4H2LH",data,e); _,disk,cd_disk,n_disk,n_total,cd_size,cd_off,comment=rec
print("total",total,"tail_start",start,"cd_off",cd_off,"cd_size",cd_size)
if cd_off<start: raise RuntimeError("central directory begins before tail")
pos=cd_off-start; stop=pos+cd_size
while pos<stop:
 r=struct.unpack_from("<4s6H3I5H2I",data,pos)
 if r[0]!=b"PK\x01\x02": raise RuntimeError("bad central header")
 nl,xl,cl=r[10],r[11],r[12]; name=data[pos+46:pos+46+nl].decode("utf-8","replace")
 if name=="modrinth.index.json":
  print("index method",r[4],"compressed",r[8],"uncompressed",r[9],"local offset",r[16],"name_len",nl,"extra",xl,"crc",f"{r[7]:08x}")
  print("index range",r[16],r[16]+29+nl+xl+r[8]); break
 pos+=46+nl+xl+cl
else: raise RuntimeError("index missing")
