"""Хвост и уши на меше Tripo → /tmp/<n>_parts.npz (индексы вершин + суставы цепочек)."""
import numpy as np, sys
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
n=sys.argv[1]
d=np.load(f'/tmp/{n}.npz'); P,E=d['P'],d['E']
bn=list(d['bn']); bp=d['bp']; B=lambda k: bp[bn.index('mixamorig:'+k)]
hips,head=B('Hips'),B('Head')
N=len(P); L=np.linalg.norm(P[E[:,0]]-P[E[:,1]],axis=1)
key=np.round(P/1e-5).astype(np.int64); _,inv=np.unique(key,axis=0,return_inverse=True); inv=inv.ravel()
o=np.argsort(inv); same=inv[o][1:]==inv[o][:-1]; SA,SB=o[:-1][same],o[1:][same]
EA=np.r_[E[:,0],SA]; EB=np.r_[E[:,1],SB]; LL=np.r_[L,np.full(len(SA),1e-9)]
G=coo_matrix((np.r_[LL,LL],(np.r_[EA,EB],np.r_[EB,EA])),shape=(N,N)).tocsr()

# --- хвост: узкое (|x|<5 см) позади спины в полосе таза
seed=np.zeros(N,bool)
for z in np.arange(hips[2]-0.12,hips[2]+0.35,0.01):
    s=(P[:,2]>=z)&(P[:,2]<z+0.01)
    wide=s&(np.abs(P[:,0]-hips[0])>0.07)
    back=P[wide,1].max() if wide.any() else 0
    seed|= s&(np.abs(P[:,0]-hips[0])<0.05)&(P[:,1]>back+0.025)
# связная компонента сида с самой дальней точкой
tipc=np.where(seed)[0][np.argmax(P[seed,1])]
sub=G[seed][:,seed]; from scipy.sparse.csgraph import connected_components
_,lab=connected_components(sub,directed=False); idx=np.where(seed)[0]
tail=idx[lab==lab[list(idx).index(tipc)]]
# корень: точка хвоста ближе всего к спине (мин. y), затем добираем корень на 1.5 см внутрь
root=tail[np.argmin(P[tail,1])]
g=dijkstra(G,indices=root,limit=0.6)
ext=np.where(dijkstra(G,indices=tail,limit=0.015,min_only=True)<0.015)[0]
tail=np.unique(np.r_[tail,ext[np.abs(P[ext,0]-hips[0])<0.06]])
C=d['C']; med=np.median(C[tail],axis=0)  # цвет меха хвоста
cd=np.linalg.norm(C[tail]-med,axis=1); tail=tail[cd<float(sys.argv[2]) if len(sys.argv)>2 else cd<9]; print('color filter kept',len(tail))
rz=P[root,2]; tail=tail[P[tail,2]>=rz-0.03]; print('below-root cut kept',len(tail))
gt=g[tail]; gt[~np.isfinite(gt)]=gt[np.isfinite(gt)].max()
tipv=tail[np.argmax(gt)]
# суставы: 5 точек по геодезике от корня
qs=np.quantile(gt,[0.0,0.25,0.5,0.75,1.0])
joints=[]
for i,q in enumerate(qs):
    w=np.abs(gt-q)<max(0.012,(qs[-1]-qs[0])*0.06)
    joints.append(P[tail[w]].mean(0))
joints[0]=P[tail[gt<qs[0]+0.01]].mean(0); joints[-1]=P[tipv]
print(n,'tail n',len(tail),'len',round(qs[-1],3),'joints',np.round(joints,3).tolist())

# --- уши: от верхней точки вниз до основания (ширина кольца растёт), по цвету шапку/бант не берём
ears={}; ej={}
for side,sg in [('Left',1),('Right',-1)]:
    m=(sg*(P[:,0]-head[0])>0.04)&(P[:,2]>head[2]+0.05)
    t=np.where(m)[0][np.argmax(P[m,2])]
    ge=dijkstra(G,indices=t,limit=0.12)
    # длина уха: где поперечник кольца > 2.2 * поперечник у кончика... берём по высоте: ухо выше базы
    zs=P[t,2]; cut=None
    for dd in np.arange(0.02,0.12,0.005):
        r=(ge>=dd-0.005)&(ge<dd)
        if r.sum()<3: continue
        w=np.ptp(P[r,0])+np.ptp(P[r,1])
        if dd>0.035 and w>0.16: cut=dd; break
    cut=cut or 0.07
    ears[side]=np.where(ge<cut)[0]
    base=P[ears[side][ge[ears[side]]>cut*0.8]].mean(0); ej[side]=[base,P[t]]
    print(side,'ear n',len(ears[side]),'cut',round(cut,3),'base',base.round(3),'tip',P[t].round(3))
np.savez(f'/tmp/{n}_parts.npz',tail=tail,tailg=gt,tailj=np.array(joints),earL=ears['Left'],earR=ears['Right'],
  earLg=dijkstra(G,indices=ears['Left'][0],limit=0.2)[ears['Left']]*0, earLj=np.array(ej['Left']),earRj=np.array(ej['Right']))
