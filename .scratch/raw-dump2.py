import os, pty, time, select

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "--import", "tsx", "src/cli.ts"])
    os._exit(1)
os.set_blocking(fd, False)
chunks = []
start = time.time()
phase = 0
while time.time() - start < 17:
    try:
        data = os.read(fd, 65536)
        if data:
            chunks.append((round(time.time()-start, 1), len(data)))
    except (OSError, BlockingIOError):
        pass
    if phase == 0 and time.time() - start > 7:
        os.write(fd, b"hi\r")
        phase = 1
        print(f"[{time.time()-start:.1f}] sent query")
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        break
    time.sleep(0.05)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
prev_t = 0
for t, n in chunks:
    if t >= 5:
        print(f"[{t:5.1f}] +{n:6d} bytes (gap {t-prev_t:4.1f}s)")
    prev_t = t
