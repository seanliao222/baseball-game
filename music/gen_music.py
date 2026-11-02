import numpy as np, random, subprocess, sys, wave, os
SR=32000
OUT=sys.argv[1]
# team: (file, bpm, tonic midi, minor?, seed)
TEAMS=[('Brothers',124,62,False,11),('Lions',128,60,False,23),('Monkeys',120,65,False,35),('Guardians',126,59,False,47),
('Dragons',132,57,True,59),('Hawks',130,64,True,71),('Dodgers',122,60,False,83),('Yankees',118,58,False,95),
('Chinese_Taipei',126,62,False,107),('Japan',128,63,False,119),('South_Korea',130,61,True,131),('Australia',124,64,False,143),
('USA',120,57,False,155),('Dominican_Rep',112,60,False,167),('Puerto_Rico',116,59,False,179),('Mexico',118,62,True,191),('Italy',122,65,False,203)]
MAJ=[0,2,4,5,7,9,11]; MIN=[0,2,3,5,7,8,10]
PROG_MAJ=[(0,[0,2,4]),(4,[0,2,4]),(5,[0,2,4]),(3,[0,2,4])]      # I V vi IV  (scale degrees of chord roots)
PROG_MIN=[(0,[0,2,4]),(5,[0,2,4]),(2,[0,2,4]),(6,[0,2,4])]      # i VI III VII
RH=[[(0,2),(3,2),(6,2),(8,4),(12,4)],[(0,4),(4,4),(8,2),(10,2),(12,4)],[(0,2),(2,2),(4,4),(8,2),(10,2),(12,2),(14,2)],[(0,6),(6,2),(8,4),(12,4)]]
def mtof(m): return 440*2**((m-69)/12)
def env(n,a,d,s,r,sr=SR):
    e=np.ones(n); na=int(a*sr); nd=int(d*sr); nr=int(r*sr)
    e[:na]=np.linspace(0,1,max(na,1)); 
    if nd>0 and na+nd<n: e[na:na+nd]=np.linspace(1,s,nd); e[na+nd:]=s
    if nr>0 and nr<n: e[-nr:]*=np.linspace(1,0,nr)
    return e
def brass(f,dur,vel=1.0):
    n=int(dur*SR); t=np.arange(n)/SR; y=np.zeros(n)
    for det in (-0.004,0.0,0.004):
        ff=f*(1+det)
        for h in range(1,9): y+=np.sin(2*np.pi*ff*h*t+0.3*h)/h**1.15*(1.0 if h<6 else 0.6)
    vib=1+0.004*np.sin(2*np.pi*5.2*t)*np.minimum(1,t/0.25)
    return y*env(n,0.03,0.08,0.75,0.06)*vel/6
def bass(f,dur):
    n=int(dur*SR); t=np.arange(n)/SR
    y=np.sin(2*np.pi*f*t)+0.35*np.sin(2*np.pi*2*f*t)+0.15*np.sin(2*np.pi*3*f*t)
    return y*env(n,0.005,0.12,0.6,0.04)*0.5
def pluck(f,dur):
    n=int(dur*SR); t=np.arange(n)/SR
    y=sum(np.sin(2*np.pi*f*h*t)/h for h in range(1,5))
    return y*env(n,0.004,0.25,0.15,0.05)*0.12
def kick(n=int(0.28*SR)):
    t=np.arange(n)/SR; f=40+110*np.exp(-t*28); ph=2*np.pi*np.cumsum(f)/SR
    return np.sin(ph)*np.exp(-t*9)*1.0
def snare(n=int(0.2*SR),rng=np.random.default_rng(1)):
    t=np.arange(n)/SR; return (rng.standard_normal(n)*np.exp(-t*20)*0.5+np.sin(2*np.pi*190*t)*np.exp(-t*25)*0.5)
def clap(rng=np.random.default_rng(2)):
    n=int(0.16*SR); t=np.arange(n)/SR; y=np.zeros(n)
    for o in (0,0.012,0.024): 
        k=int(o*SR); y[k:]+=rng.standard_normal(n-k)*np.exp(-(t[:n-k])*40)
    y=np.diff(y,prepend=0); return y*0.55
def hat(rng=np.random.default_rng(3)):
    n=int(0.05*SR); t=np.arange(n)/SR; y=np.diff(rng.standard_normal(n),prepend=0); return y*np.exp(-t*90)*0.25
def put(buf,x,pos):
    i=int(pos*SR); j=min(len(buf),i+len(x))
    if i<len(buf): buf[i:j]+=x[:j-i]
def render(name,bpm,tonic,minor,seed):
    rnd=random.Random(seed); scale=MIN if minor else MAJ; prog=PROG_MIN if minor else PROG_MAJ
    beat=60/bpm; bar=4*beat; s16=beat/4; BARS=16; total=BARS*bar+1.0
    buf=np.zeros(int(total*SR))
    def deg(d): o,i=divmod(d,7); return tonic+12*o+scale[i]
    def phrase(sd,lift=0):
        r=random.Random(sd); notes=[]; cur=r.choice([0,2,4])+7
        for b in range(4):
            root=prog[b][0]; rh=RH[r.randrange(4)] if b<3 else RH[0]
            for k,(st,ln) in enumerate(rh):
                if k==0: cur=root+r.choice([0,2,4])+7
                else: cur+=r.choice([-2,-1,-1,0,1,1,2])
                cur=max(4,min(cur,13))
                notes.append((b,st,ln,cur))
        # resolve last note
        b,st,ln,_=notes[-1]; notes[-1]=(b,st,ln,7+ (0 if lift==0 else 7))
        return [(b,st,ln,d+lift) for b,st,ln,d in notes]
    A=phrase(seed*3+1); B=phrase(seed*3+2); C=phrase(seed*3+1,lift=0); D=phrase(seed*3+1,lift=7)
    phr=[A,B,C,D]
    for p in range(4):
        for b,st,ln,d in phr[p]:
            bi=p*4+b; pos=bi*bar+st*s16; dur=ln*s16*0.95
            vel=1.0 if st%4==0 else 0.8
            put(buf,brass(mtof(deg(d)),dur,vel),pos)
            if p==3: put(buf,brass(mtof(deg(d-2)),dur,vel*0.7),pos)       # harmonised last phrase
    for bi in range(BARS):
        root,tri=prog[bi%4]; t0=bi*bar
        for q in range(4):
            put(buf,bass(mtof(deg(root)-24 if q%2==0 else deg(root+4)-24),beat*0.45),t0+q*beat)
            put(buf,bass(mtof(deg(root)-24),beat*0.2),t0+q*beat+beat/2) if q%2==1 else None
        for q in (0,2): 
            for d in tri: put(buf,pluck(mtof(deg(root+d)-12),beat*1.8),t0+q*beat)
        # stomp-stomp-clap + backbeat
        for q in range(4):
            put(buf,kick(),t0+q*beat) if q in (0,2) else None
            put(buf,snare(),t0+q*beat) if q in (1,3) else None
            put(buf,clap(),t0+q*beat) if q in (1,3) else None
        for e in range(8): put(buf,hat(),t0+e*beat/2)
        put(buf,kick(),t0+2.5*beat) if bi%2 else None
    buf=buf[:int(BARS*bar*SR)]                                     # exact loop length
    buf/=max(1e-9,np.abs(buf).max()); buf*=0.9
    pcm=(buf*32767).astype(np.int16)
    wav=os.path.join(OUT,name+'.wav'); w=wave.open(wav,'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes()); w.close()
    subprocess.run(['ffmpeg','-y','-loglevel','error','-i',wav,'-codec:a','libmp3lame','-b:a','112k','-af','loudnorm=I=-16:TP=-1.5',os.path.join(OUT,name+'.mp3')],check=True); os.remove(wav)
    print(name,round(BARS*bar,1),'s')
for t in TEAMS: render(*t)
