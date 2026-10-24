"""Official Google archive fallback; use after its hostname is allowed.

python install-android36-fallback.py https://dl-ssl.google.com/android/repository/
Requires previously fetched official repository metadata. Never skips checksums.
"""
from pathlib import Path
from xml.etree import ElementTree as ET
from urllib.request import urlopen
import hashlib,os,shutil,sys,tempfile,zipfile
base=Path('/workspace/longball-setup');sdk=base/'android-sdk'
origin=sys.argv[1] if len(sys.argv)>1 else 'https://dl.google.com/android/repository/'
assert origin in ['https://dl.google.com/android/repository/','https://dl-ssl.google.com/android/repository/']
metadata=ET.fromstring((base/'downloads/android-repository2-3.xml').read_bytes())
items=[('build-tools;36.0.0','build-tools_r36_linux.zip','b0b6376977657e8ad9b969bacf4093601da2c6fb','build-tools/36.0.0','aapt2'),('platforms;android-36','platform-36_r02.zip','2c1a80dd4d9f7d0e6dd336ec603d9b5c55a6f576','platforms/android-36','android.jar')]
for package,name,digest,relative,expected_file in items:
    node=next(p for p in metadata.findall('remotePackage') if p.attrib['path']==package)
    archive=next(a.find('complete') for a in node.findall('./archives/archive') if a.findtext('host-os') in [None,'linux'])
    assert archive.findtext('url')==name and archive.findtext('checksum')==digest
    assert archive.find('checksum').attrib['type']=='sha1'
    target=sdk/relative
    if (target/expected_file).is_file():
        print('Retained '+relative)
        continue
    assert not target.exists(),f'Preserve incomplete existing directory: {target}'
    download=base/'downloads'/name
    if not download.exists():
        temporary=download.with_suffix('.part')
        with urlopen(origin+name) as response,temporary.open('wb') as output:shutil.copyfileobj(response,output)
        temporary.rename(download)
    with download.open('rb') as source:actual=hashlib.file_digest(source,'sha1').hexdigest()
    assert actual==digest and download.stat().st_size==int(archive.findtext('size')),'Official archive verification failed'
    with tempfile.TemporaryDirectory(dir=base) as directory:
        staging=Path(directory)
        with zipfile.ZipFile(download) as z:
            for info in z.infolist():
                path=(staging/info.filename).resolve();assert path.is_relative_to(staging.resolve())
                assert (info.external_attr >> 16)&0o170000 != 0o120000,'Unexpected archive symlink'
                z.extract(info,staging)
                mode=info.external_attr >> 16
                if mode:os.chmod(path,mode&0o777)
        roots=list(staging.iterdir());assert len(roots)==1 and roots[0].is_dir()
        root=roots[0]
        assert (root/expected_file).is_file() and (root/'source.properties').is_file()
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.move(str(root),target)
    print('Verified and installed '+relative)
