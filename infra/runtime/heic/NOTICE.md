The private HEIC helper links unmodified libheif1.23.6 and libde2651.1.3 under their upstream LGPL terms. Production disables dynamic codec plugins, encoders and examples. The separate generated test fixtures use a test-only native x265 encoder; that encoder is not included in this runtime.

Verbatim licenses are in `/opt/longball-heic/share/licenses`. Exact corresponding upstream archives and this wrapper/build source are in `/opt/longball-heic/share/sources`:

- https://github.com/strukturag/libheif/releases/download/v1.23.6/libheif-1.23.6.tar.gz — SHA256 `4484346dc5995319dbc11e3a1c35d0a2ec46511ce370900869337fd2c7033125`
- https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz — SHA256 `554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905`

Rebuild with `node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`, Debian's g++, make, CMake, curl, CA certificates and pkg-config. Put the supplied files in `/src`, run `sh /src/build.sh`, create `/opt/longball-heic/bin`, then compile:

```sh
cc -O2 -Wall -Wextra -Werror -I/opt/longball-heic/include \
 /src/decode.c -L/opt/longball-heic/lib -lheif \
 -Wl,--disable-new-dtags,-rpath,'$ORIGIN/../lib' \
 -o /opt/longball-heic/bin/longball-heic
```

The libraries remain dynamically linked and can be replaced in a rebuilt image. The helper's relative RPATH resolves both libraries from the adjacent `lib` directory. Source archives retain the original per-file copyright and license notices.
