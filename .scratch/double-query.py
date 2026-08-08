import os, pty, time, select

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "--import", "tsx", "src/cli.ts"])
    os._exit(1)
os.set_blocking(fd, False)
chunks = []
start = time.time()
phase = 0
while time.time() - start < 22:
    try:
        data = os.read(fd, 65536)
        if data:
            chunks.append((round(time.time()-start, 1), len(data)))
    except (OSError, BlockingIOError):
        pass
    if phase == 0 and time.time() - start > 6:
        os.write(fd, b"q1\r")
        phase = 1
        print(f"[{time.time()-start:.1f}] sent q1")
    if phase == 1 and time.time() - start > 14:
        os.write(fd, b"q2\r")
        phase = 2
        print(f"[{time.time()-start:.1f}] sent q2")
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        break
    time.sleep(0.05)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
print("--- 输出时间线 ---")
for t, n in chunks:
    if t >= 4:
        print(f"[{t:5.1f}] +{n}")
