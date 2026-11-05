"""Read-only Shopify public catalog snapshot. Never prints access credentials."""
import re,json,urllib.request,csv,datetime
from pathlib import Path
root=Path(__file__).resolve().parents[1]
config=(root/'public/config.js').read_text()
get=lambda k:re.search(k+r':\s*"([^"]*)"',config).group(1)
query='''query($after:String){products(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id handle title productType tags featuredImage{id url width height altText}images(first:50){pageInfo{hasNextPage}nodes{id url width height altText}}}}}'''
products=[];after=None
while True:
 req=urllib.request.Request('https://'+get('shopifyDomain')+'/api/'+get('apiVersion')+'/graphql.json',data=json.dumps({'query':query,'variables':{'after':after}}).encode(),headers={'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':get('storefrontToken')})
 with urllib.request.urlopen(req,timeout=30) as r: data=json.load(r)
 if data.get('errors'):raise RuntimeError(str(data['errors']))
 conn=data['data']['products'];products+=conn['nodes']
 if not conn['pageInfo']['hasNextPage']:break
 after=conn['pageInfo']['endCursor']
out=root/'audit';out.mkdir(exist_ok=True)
(out/'catalog-source.json').write_text(json.dumps({'captured_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'products':products},indent=2))
with (out/'product-image-pixels.csv').open('w',newline='') as f:
 cols=['product_id','handle','title','product_type','image_id','source_url','width_px','height_px','total_pixels','featured','face_review','full_body_review','gallery_truncated']
 w=csv.DictWriter(f,fieldnames=cols);w.writeheader()
 for p in products:
  for im in p['images']['nodes']:
   w.writerow(dict(product_id=p['id'],handle=p['handle'],title=p['title'],product_type=p['productType'],image_id=im['id'],source_url=im['url'],width_px=im['width'],height_px=im['height'],total_pixels=(im['width'] or 0)*(im['height'] or 0),featured=im['id']==(p['featuredImage'] or {}).get('id'),face_review='not_visually_verified',full_body_review='not_visually_verified',gallery_truncated=p['images']['pageInfo']['hasNextPage']))
print(json.dumps({'products':len(products),'images':sum(len(p['images']['nodes']) for p in products),'truncated_galleries':sum(p['images']['pageInfo']['hasNextPage'] for p in products)}))
