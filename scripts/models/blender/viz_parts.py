import numpy as np
from PIL import Image, ImageDraw
row=[]
for n in ['hooligan','kind','glitter']:
    d=np.load(f'/tmp/{n}.npz'); P=d['P']; q=np.load(f'/tmp/{n}_parts.npz')
    col=np.full((len(P),3),200); col[q['tail']]=[230,30,30]; col[q['earL']]=[30,30,230]; col[q['earR']]=[30,160,230]
    for view in ['side','back']:
        S=400; im=Image.new('RGB',(S,S),'white'); dr=ImageDraw.Draw(im)
        z0,z1=P[:,2].min(),P[:,2].max(); sc=S/(z1-z0)*0.95
        h=P[:,1] if view=='side' else P[:,0]
        dep=-P[:,0] if view=='side' else -P[:,1]
        for i in np.argsort(dep):
            dr.point((S/2+h[i]*sc, S-10-(P[i,2]-z0)*sc), tuple(col[i]))
        row.append(im)
c=Image.new('RGB',(400*len(row),400)); [c.paste(r,(400*i,0)) for i,r in enumerate(row)]; c.save('/tmp/parts.png')
