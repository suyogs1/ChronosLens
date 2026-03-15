import CameraStream from "@/components/CameraStream";

export default function Home() {
  return (
    <main className="min-h-screen bg-stone-950 text-stone-200 selection:bg-amber-900/50 relative overflow-hidden font-sans">
      {/* Ambient background effects */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-amber-900/10 rounded-full blur-[120px] mix-blend-screen"></div>
        <div className="absolute bottom-[-10%] right-[10%] w-[50%] h-[60%] bg-orange-950/15 rounded-full blur-[150px] mix-blend-screen opacity-50"></div>
        <div className="absolute top-[20%] right-[10%] w-[30%] h-[30%] bg-stone-800/20 rounded-full blur-[100px] mix-blend-overlay"></div>
      </div>

      <div className="container mx-auto px-4 py-8 lg:py-16 relative z-10 flex flex-col items-center min-h-screen">
        <header className="mb-12 text-center max-w-3xl mx-auto flex flex-col items-center">
          <div className="inline-flex items-center justify-center gap-3 px-4 py-1.5 rounded-full border border-amber-900/40 bg-stone-900/60 backdrop-blur-md shadow-lg shadow-black/20 mb-8">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.6)]"></span>
            <span className="text-xs font-bold tracking-[0.25em] text-amber-500/90 uppercase">Gemini 3.1 Live Powered</span>
          </div>
          <h1 className="text-5xl md:text-7xl lg:text-8xl font-extralight tracking-tight mb-6 text-stone-100 mix-blend-plus-lighter relative">
            Chronos <span className="font-semibold text-transparent bg-clip-text bg-gradient-to-br from-amber-200 via-amber-500 to-amber-900 drop-shadow-sm">Lens</span>
          </h1>
          <p className="text-lg md:text-xl text-stone-400 font-light leading-relaxed max-w-2xl text-center">
            Point your lens at history. Witness the world as it once was.
          </p>
        </header>

        <section className="w-full flex-1 flex flex-col justify-center items-center">
          <CameraStream />
        </section>
      </div>
    </main>
  );
}
