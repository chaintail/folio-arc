import os,secrets,pathlib,subprocess
base=pathlib.Path('.runtime')
for part in ['as-state','core-state','runner','viewer','tls','secrets/as','secrets/mcp','secrets/core','secrets/runner']:
 p=base/part;p.mkdir(parents=True,exist_ok=True);os.chown(p,1000,1000);os.chmod(p,0o700)
if not (base/'tls/cert.pem').exists():
 subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',str(base/'tls/key.pem'),'-out',str(base/'tls/cert.pem'),'-subj','/CN=tls-fixture','-addext','subjectAltName=DNS:tls-fixture,DNS:localhost,IP:::1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 for name in ['key.pem','cert.pem']:
  p=base/'tls'/name;os.chown(p,1000,1000);os.chmod(p,0o400)
pathlib.Path('evidence').mkdir(exist_ok=True);os.chown('evidence',1000,1000)
