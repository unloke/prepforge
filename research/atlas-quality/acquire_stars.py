"""Serial observed public study likes, never inferred from search snippets."""
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE=Path(__file__).resolve().parent/'corpus'
OUT=BASE/'stars.json'

def now(): return datetime.now(timezone.utc).isoformat()

def main():
    studies=json.loads((BASE/'manifest.json').read_text(encoding='utf8'))
    saved=json.loads(OUT.read_text(encoding='utf8')) if OUT.exists() else []
    byid={r['study_id']:r for r in saved}
    for study in studies:
        sid=study['id']
        if sid in byid: continue
        url=f'https://lichess.org/study/{sid}'
        row={'study_id':sid,'title':study['title'],'source_url':url,'observed_at_utc':now(),
             'likes':None,'status':'unavailable','metric':'public Lichess study likes; not a star rating or validated quality score'}
        try:
            request=urllib.request.Request(url,headers={'User-Agent':'PrepForge-research/1.0','Accept':'text/html'})
            with urllib.request.urlopen(request,timeout=40) as response:
                raw=response.read(); row['http_status']=response.status
                row['content_type']=response.headers.get('Content-Type')
                row['final_url']=response.url
            text=raw.decode('utf8')
            row['response_sha256']=hashlib.sha256(raw).hexdigest()
            # Lichess embeds study metadata as escaped JSON in its public page.
            match=re.search(r'\\?"likes\\?"\s*:\s*(\d+)',text)
            if match:
                row.update(likes=int(match.group(1)),status='observed',
                    extraction='literal likes integer from embedded study metadata',
                    raw_metadata_excerpt=text[max(0,match.start()-130):match.end()+100],
                    excerpt_start_offset=max(0,match.start()-130))
            else:
                row['reason']='No literal likes field in returned page; no count inferred'
                title=re.search(r'<title>(.*?)</title>',text,re.S)
                if title: row['raw_page_title']=title.group(1)
        except urllib.error.HTTPError as exc:
            row['http_status']=exc.code; row['reason']=str(exc)
            if exc.code==429:
                delay=exc.headers.get('Retry-After','60')
                cooldown=max(60,int(delay)) if delay.isdigit() else 60
                row['cooldown_seconds']=cooldown
                print(f'{sid}: 429; immediate {cooldown}s cooldown',flush=True)
                time.sleep(cooldown)
        except Exception as exc:
            row['reason']=str(exc)
        byid[sid]=row
        OUT.write_text(json.dumps(list(byid.values()),ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        print(f'{len(byid)}/{len(studies)} {sid}: {row["likes"] if row["likes"] is not None else row.get("reason", "unavailable")}',flush=True)
        time.sleep(1)

if __name__=='__main__': main()
