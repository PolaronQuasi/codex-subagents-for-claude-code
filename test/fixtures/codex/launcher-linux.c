/* Test-only Linux x86_64 launcher; no libc or dynamic loader is required.
 * Rebuild with the existing compiler in golang:1.27.3-bookworm:
 * cc -Os -fno-builtin -fno-stack-protector -nostdlib -static
 *    -Wl,-n,--build-id=none -s launcher-linux.c -o launcher-linux
 * launcher-linux.mjs contains the resulting bytes and their SHA-256.
 * Like launcher.c, this replaces itself with the isolated Node fixture.
 */
#if !defined(__linux__) || !defined(__x86_64__)
#error This fixed fixture targets Linux x86_64.
#endif

__asm__(".global _start\n_start:\nmov %rsp,%rdi\nand $-16,%rsp\ncall launch\n");

static char *value(char *text, const char *name) {
    while (*name && *text == *name) { text++; name++; }
    return *name ? (char *)0 : text;
}

__attribute__((noreturn)) void launch(unsigned long *stack) {
    unsigned long argc = stack[0];
    char **argv = (char **)(stack + 1);
    char **env = argv + argc + 1;
    char *node = 0, *entry = 0;
    for (char **item = env; *item; item++) {
        char *found = value(*item, "CODEX_FIXTURE_NODE=");
        if (found) node = found;
        found = value(*item, "CODEX_FIXTURE_ENTRY=");
        if (found) entry = found;
    }
    if (node && *node && entry && *entry) {
        char *args[argc + 2];
        args[0] = node;
        args[1] = entry;
        for (unsigned long i = 1; i < argc; i++) args[i + 1] = argv[i];
        args[argc + 1] = 0;
        __asm__ volatile("syscall" : : "a"(59), "D"(node), "S"(args), "d"(env)
                         : "rcx", "r11", "memory");
    }
    __asm__ volatile("syscall" : : "a"(60), "D"(2) : "rcx", "r11", "memory");
    __builtin_unreachable();
}
