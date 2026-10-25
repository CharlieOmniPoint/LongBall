from pathlib import Path
from urllib.parse import urlsplit
import os
properties=Path(__file__).resolve().parents[1]/'.local/gradle/gradle.properties'
properties.parent.mkdir(parents=True,exist_ok=True)
text=properties.read_text() if properties.exists() else ''
existing={line.split('=',1)[0].strip():line.split('=',1)[1].strip() for line in text.splitlines() if '=' in line and not line.startswith('#')}
updates={'org.gradle.workers.max':'2','org.gradle.jvmargs':'-Xmx4096m -XX:MaxMetaspaceSize=1024m'}
for scheme in ['https','http']:
    url=os.environ.get(scheme.upper()+'_PROXY')
    if url:
        proxy=urlsplit(url)
        assert proxy.scheme in ['http','https'] and proxy.hostname
        assert proxy.username is None and proxy.password is None,'Authenticated proxy needs separate secure handling'
        updates['systemProp.'+scheme+'.proxyHost']=proxy.hostname
        updates['systemProp.'+scheme+'.proxyPort']=str(proxy.port or (443 if proxy.scheme=='https' else 80))
updates['systemProp.http.nonProxyHosts']='localhost|127.*|[::1]'
java17=Path('/workspace/longball-setup/jdk17/usr/lib/jvm/msopenjdk-17-amd64')
if (java17/'bin/java').exists(): updates['org.gradle.java.installations.paths']=str(java17)
added=[]
for name,value in updates.items():
    if name in existing:
        assert existing[name]==value,f'Preserve existing differing property {name}'
    else: added.append(name+'='+value)
if added:
    with properties.open('a') as output:
        if text and not text.endswith('\n'):output.write('\n')
        output.write('# Local LongBall cloud SDK build settings; no credentials.\n'+'\n'.join(added)+'\n')
print('Configured local Gradle HTTP/HTTPS proxy and two-worker build settings; values not logged')
