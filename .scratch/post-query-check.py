import os, pty, time, select

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "--import", "tsx", "src/cli.ts"])
    os._exit(1)
os.set_blocking(fd, False)
output = b""
start = time.time()
phase = 0
exited = False
while time.time() - start < 22:
    try:
        data = os.read(fd, 65536)
        if data:
            output += data
    except (OSError, BlockingIOError):
        pass
    if phase == 0 and time.time() - start > 7:
        os.write(fd, b"hi\r")   # 查询（触发错误）
        phase = 1
        print(f"[{time.time()-start:.1f}] sent query")
    if phase == 1 and time.time() - start > 11:
        os.write(fd, b"abc")    # 普通字符，无 slash
        phase = 2
        print(f"[{time.time()-start:.1f}] sent 'abc'")
    if phase == 2 and time.time() - start > 14:
        os.write(fd, b"/quit\r")
        phase = 3
        print(f"[{time.time()-start:.1f}] sent /quit")
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        exited = True
        print(f"[{time.time()-start:.1f}] EXITED")
        break
    time.sleep(0.05)
if not exited:
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    print("NOT EXITED")
text = output.decode("utf-8", "replace")
i1 = text.rfind("abc")
print("abc echoed:", i1 >= 0)
i2 = text.rfind("/quit")
print("/quit echoed:", i2 >= 0)
print("TAIL:", repr(text[-200:]))
