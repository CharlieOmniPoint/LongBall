from pathlib import Path
from urllib.request import urlopen
import gzip,hashlib,re,shutil,subprocess,json,os
base=Path('/workspace/longball-setup')
downloads=base/'downloads/microsoft-jdk17'
downloads.mkdir(parents=True,exist_ok=True)
urlbase='https://packages.microsoft.com/debian/12/prod/'
for name,url in [('microsoft.asc','https://packages.microsoft.com/keys/microsoft.asc'),('InRelease',urlbase+'dists/bookworm/InRelease'),('Packages.gz',urlbase+'dists/bookworm/main/binary-amd64/Packages.gz')]:
    if not (downloads/name).exists():
        with urlopen(url) as response:(downloads/name).write_bytes(response.read())
gnupg=downloads/'gnupg';gnupg.mkdir(mode=0o700,exist_ok=True)
command=['gpg','--batch','--no-options','--homedir',str(gnupg)]
fingerprint=subprocess.run(command+['--with-colons','--import-options','show-only','--import',str(downloads/'microsoft.asc')],capture_output=True,text=True,check=True).stdout
expected='BC528686B50D79E339D3721CEB3E94ADBE1229CF'
assert any(line.startswith('fpr:') and line.split(':')[9]==expected for line in fingerprint.splitlines()),'Microsoft signing key fingerprint mismatch'
subprocess.run(command+['--import',str(downloads/'microsoft.asc')],check=True)
subprocess.run(command+['--yes','--output',str(downloads/'Release'),'--decrypt',str(downloads/'InRelease')],check=True)
release=(downloads/'Release').read_text()
sha_section=release.split('SHA256:\n',1)[1].split('\n\n',1)[0]
entries=[line.split() for line in sha_section.splitlines() if line.startswith(' ')]
entry=next(v for v in entries if v[2]=='main/binary-amd64/Packages.gz')
packages=(downloads/'Packages.gz').read_bytes()
assert len(packages)==int(entry[1]) and hashlib.sha256(packages).hexdigest()==entry[0],'Signed package-index checksum mismatch'
records=[]
for paragraph in gzip.decompress(packages).decode().split('\n\n'):
    if paragraph.startswith('Package: msopenjdk-17\n'):
        fields=dict(line.split(': ',1) for line in paragraph.splitlines() if ': ' in line)
        records.append(fields)
def version(record):return tuple(map(int,re.findall(r'\d+',record['Version'])))
record=next(record for record in records if record['Version']=='17.0.20.1-1')
archive=downloads/Path(record['Filename']).name
if not archive.exists():
    with urlopen(urlbase+record['Filename']) as response, archive.with_suffix('.part').open('wb') as output:shutil.copyfileobj(response,output)
    archive.with_suffix('.part').rename(archive)
with archive.open('rb') as source:actual=hashlib.file_digest(source,'sha256').hexdigest()
assert archive.stat().st_size==int(record['Size']) and actual==record['SHA256'],'JDK package checksum mismatch'
target=base/'jdk17'
if not target.exists():
    target.mkdir()
    subprocess.run(['dpkg-deb','--extract',str(archive),str(target)],check=True)
java=target/'usr/lib/jvm/msopenjdk-17-amd64/bin/java'
subprocess.run([str(java),'-version'],check=True)
(base/'jdk17-toolchain.json').write_text(json.dumps({'version':record['Version'],'java_home':str(java.parent.parent),'package_sha256':actual,'signing_key':expected},indent=2)+'\n')
print('Verified Microsoft repository signature, package-index SHA256 and JDK package SHA256',flush=True)
