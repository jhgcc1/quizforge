#!/usr/bin/env bash
cd "$(dirname "$0")/.."; mkdir -p .local; exec > .local/rescan.log 2>&1
for s in api worker web; do docker build -q -f apps/$s/Dockerfile -t quizforge-$s:local . >/dev/null && echo "$s built" || echo "$s BUILD FAILED"; done
for s in api worker web; do
  echo "=== $s"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/.trivyignore:/.trivyignore:ro" aquasec/trivy:0.58.1 image --severity HIGH,CRITICAL --ignore-unfixed --ignorefile /.trivyignore --format json quizforge-$s:local 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin); rows=[(r['Target'],v['PkgName'],v['InstalledVersion'],v['VulnerabilityID'],v['Severity'],v.get('FixedVersion','')) for r in d.get('Results',[]) for v in (r.get('Vulnerabilities') or [])]
print('findings:',len(rows))
for r in rows[:25]: print('  ',*r)"
done
echo RESCAN_DONE
