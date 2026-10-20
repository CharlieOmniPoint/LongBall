#!/usr/bin/env bash
set -euo pipefail
export ANDROID_HOME=/workspace/longball-setup/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME=/workspace/longball-setup/android-home
export XDG_CACHE_HOME=/workspace/longball-setup/cache
mkdir -p "$ANDROID_HOME" "$ANDROID_USER_HOME" "$XDG_CACHE_HOME" /workspace/longball-setup/downloads
python - <<'ANDROID_HOME_COMPAT'
from pathlib import Path
import os
home_config = Path.home() / '.android'
target = Path(os.environ['ANDROID_USER_HOME'])
if not home_config.exists() and not home_config.is_symlink():
    try:
        home_config.symlink_to(target, target_is_directory=True)
    except PermissionError:
        raise SystemExit('adb needs the missing ~/.android link; rerun this setup through the execution environment permission flow.')
ANDROID_HOME_COMPAT
python - <<'PY'
from pathlib import Path
from urllib.request import urlopen
from xml.etree import ElementTree as ET
import hashlib, json, os, shutil, tempfile, zipfile
base=Path('/workspace/longball-setup')
url='https://dl.google.com/android/repository/repository2-3.xml'
metadata=base/'downloads/android-repository2-3.xml'
if not metadata.exists():
    with urlopen(url) as response: metadata.write_bytes(response.read())
xml=metadata.read_bytes()
root=ET.fromstring(xml)
package=next(p for p in root.findall('remotePackage') if p.attrib['path']=='cmdline-tools;23.0')
archive=next(a for a in package.findall('./archives/archive') if a.findtext('host-os')=='linux')
complete=archive.find('complete');checksum=complete.find('checksum')
name=complete.findtext('url');expected=checksum.text;algorithm=checksum.attrib['type'];size=int(complete.findtext('size'))
assert name=='commandlinetools-linux-16111833_latest.zip',name
assert algorithm=='sha1' and expected=='e025545c62a8e64c7559119566a569fb1dec5f60'
destination=base/'downloads'/name
if not destination.exists():
    temporary=destination.with_suffix('.part')
    with urlopen('https://dl.google.com/android/repository/'+name) as response, temporary.open('wb') as output:
        shutil.copyfileobj(response,output)
    temporary.rename(destination)
assert destination.stat().st_size==size,'Unexpected archive length'
with destination.open('rb') as source: actual=hashlib.file_digest(source,algorithm).hexdigest()
assert actual==expected,'Official archive checksum mismatch'
print(f'Verified official Android cmdline-tools 23.0 {algorithm}: {actual}',flush=True)
tools=base/'android-sdk/cmdline-tools'
target=tools/'23.0'
if not target.exists():
    tools.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=tools) as directory:
        staging=Path(directory)
        with zipfile.ZipFile(destination) as z:
            for member in z.infolist():
                output=(staging/member.filename).resolve()
                assert output.is_relative_to(staging.resolve()),member.filename
                z.extract(member,staging)
                mode=member.external_attr >> 16
                if mode: os.chmod(output,mode & 0o777)
        shutil.move(str(staging/'cmdline-tools'),target)
latest=tools/'latest'
if not latest.exists(): latest.symlink_to('23.0',target_is_directory=True)
metadata={'package':'cmdline-tools;23.0','archive':name,'official_checksum_type':algorithm,'official_checksum':expected,'size':size}
(base/'android-toolchain.json').write_text(json.dumps(metadata,indent=2)+'\n')
PY
export PATH="$ANDROID_HOME/cmdline-tools/23.0/bin:$ANDROID_HOME/platform-tools:$PATH"
python - <<'PY'
import os,subprocess
android='/workspace/longball-setup/android-sdk/cmdline-tools/23.0/bin/android'
root='/workspace/longball-setup/android-sdk'
# Command-line tools 23 uses Android CLI. SDK licenses are included in its
# first-run terms flow; sdkmanager --licenses is obsolete in this release.
from pathlib import Path
packages=['platform-tools','platforms/android-37.0','platforms/android-36','build-tools/37.0.0','build-tools/36.0.0','ndk/27.1.12297006']
missing=[package for package in packages if not (Path(root)/package/'source.properties').is_file()]
if missing:
    subprocess.run([android,'--no-metrics','--sdk='+root,'sdk','install',*missing],input='y\n'*200,text=True,check=True)
else:
    print('Reusing installed Android SDK components')
assert (Path(root)/'platforms/android-37.0/android.jar').is_file()
assert (Path(root)/'platforms/android-36/android.jar').is_file()
assert (Path(root)/'build-tools/37.0.0/aapt2').is_file()
assert (Path(root)/'build-tools/36.0.0/aapt2').is_file()
assert (Path(root)/'ndk/27.1.12297006/ndk-build').is_file()
assert (Path(root)/'platform-tools/adb').is_file()
print('Android SDK36/37.0, build tools36.0.0/37.0.0, NDK27.1.12297006 and platform-tools verified')
PY
python "$(dirname "${BASH_SOURCE[0]}")/setup-jdk17.py"
python "$(dirname "${BASH_SOURCE[0]}")/configure-gradle.py"
