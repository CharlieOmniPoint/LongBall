/* Thin bounded wrapper around maintained libheif/libde265; no codec implementation. */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>
#include <libheif/heif.h>
#include <libheif/heif_security.h>
#include <libheif/heif_sequences.h>
#include <libheif/heif_items.h>
#include <libheif/heif_image_handle.h>
#include <libheif/heif_decoding.h>
#ifdef __linux__
#include <stddef.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#endif
#define MAX_BYTES (15U*1024U*1024U)
#define MAX_PIXELS 40000000ULL
#define ALLOW(call) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##call,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
static void fail(void){fputs("HEIC_DECODE_REJECTED\n",stderr);_exit(1);}
static void limit(int resource,rlim_t value){struct rlimit r={value,value};if(setrlimit(resource,&r))fail();}
static void sandbox(void){
#ifdef __linux__
#if defined(__x86_64__)
 const unsigned int arch=AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
 const unsigned int arch=AUDIT_ARCH_AARCH64;
#else
#error Unsupported Linux architecture
#endif
 struct sock_filter filter[]={
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,arch,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#ifdef __NR_clone3
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone3,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS),
#endif
#ifdef __NR_clone
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone,0,4),
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
 BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,CLONE_THREAD,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
 BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
#endif
 ALLOW(read),ALLOW(write),ALLOW(readv),ALLOW(writev),ALLOW(pread64),ALLOW(pwrite64),ALLOW(lseek),ALLOW(close),ALLOW(fstat),ALLOW(newfstatat),
 ALLOW(mmap),ALLOW(mprotect),ALLOW(munmap),ALLOW(mremap),ALLOW(madvise),ALLOW(brk),
 ALLOW(rt_sigaction),ALLOW(rt_sigprocmask),ALLOW(rt_sigreturn),ALLOW(sigaltstack),
 ALLOW(exit),ALLOW(exit_group),ALLOW(clock_gettime),ALLOW(gettimeofday),ALLOW(getrusage),ALLOW(getpid),ALLOW(gettid),
 ALLOW(futex),ALLOW(set_robust_list),ALLOW(rseq),ALLOW(sched_yield),ALLOW(sched_getaffinity),ALLOW(getrandom),ALLOW(ftruncate),
 BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)};
 struct sock_fprog program={(unsigned short)(sizeof(filter)/sizeof(filter[0])),filter};
 if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program))fail();
#else
 fail(); /* Production decoder requires the Linux syscall sandbox. */
#endif
}
static int pixels(int w,int h){return w>0&&h>0&&(uint64_t)w*(uint64_t)h<=MAX_PIXELS;}
static void checked(struct heif_error error){if(error.code!=heif_error_Ok)fail();}
static void write_all(int fd,const unsigned char *bytes,size_t n){while(n){ssize_t written=write(fd,bytes,n);if(written<1)fail();bytes+=written;n-=(size_t)written;}}
int main(int argc,char **argv){
 if(argc==2&&!strcmp(argv[1],"--version")){printf("libheif:%s/libde265\n",heif_get_version());return 0;}
 if(argc!=3)fail();
 limit(RLIMIT_AS,768ULL*1024*1024);limit(RLIMIT_CPU,8);limit(RLIMIT_FSIZE,MAX_PIXELS*4);limit(RLIMIT_CORE,0);alarm(8);
 int input=open(argv[1],O_RDONLY|O_NOFOLLOW|O_CLOEXEC);struct stat st;if(input<0||fstat(input,&st)||!S_ISREG(st.st_mode)||st.st_size<16||st.st_size>MAX_BYTES)fail();
 unsigned char *bytes=malloc((size_t)st.st_size);if(!bytes)fail();size_t offset=0;while(offset<(size_t)st.st_size){ssize_t n=read(input,bytes+offset,(size_t)st.st_size-offset);if(n<1)fail();offset+=(size_t)n;}close(input);
 int output=open(argv[2],O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(output<0)fail();if(output!=3){if(dup2(output,3)<0)fail();close(output);}output=3;
 close(0);
#ifdef __linux__
 if(syscall(__NR_close_range,4,UINT_MAX,0)<0)fail();
#else
 fail();
#endif
 limit(RLIMIT_NOFILE,16);
 struct heif_context *ctx=heif_context_alloc();if(!ctx)fail();
 struct heif_security_limits *limits=heif_context_get_security_limits(ctx);if(!limits||limits->version<4)fail();
 limits->max_image_size_pixels=MAX_PIXELS;limits->max_number_of_tiles=256;limits->max_items=256;limits->max_color_profile_size=1024*1024;
 limits->max_memory_block_size=192ULL*1024*1024;limits->max_total_memory=384ULL*1024*1024;limits->max_iloc_extents_per_item=64;
 limits->max_children_per_box=256;limits->max_sequence_frames=1;limits->max_number_of_file_brands=64;limits->parent=NULL;
 heif_context_set_max_decoding_threads(ctx,1);sandbox();
 checked(heif_context_read_from_memory_without_copy(ctx,bytes,(size_t)st.st_size,NULL));
 if(heif_context_has_sequence(ctx)||heif_context_get_number_of_top_level_images(ctx)!=1)fail();
 int count=heif_context_get_number_of_items(ctx);if(count<1||count>256)fail();heif_item_id ids[256];if(heif_context_get_list_of_item_IDs(ctx,ids,count)!=count)fail();
 int hevc=0;
 for(int index=0;index<count;index++){
  uint32_t type=heif_item_get_item_type(ctx,ids[index]);
  if(type==heif_fourcc('h','v','c','1')||type==heif_fourcc('g','r','i','d')||type==heif_fourcc('i','d','e','n')||type==heif_fourcc('i','o','v','l')){
   struct heif_image_handle *handle=NULL;checked(heif_context_get_image_handle(ctx,ids[index],&handle));
   if(!pixels(heif_image_handle_get_width(handle),heif_image_handle_get_height(handle))||!pixels(heif_image_handle_get_ispe_width(handle),heif_image_handle_get_ispe_height(handle)))fail();
   heif_image_handle_release(handle);if(type==heif_fourcc('h','v','c','1'))hevc=1;
  }else if(type!=heif_item_type_exif&&type!=heif_item_type_mime)fail();
 }
 if(!hevc)fail();
 struct heif_image_handle *primary=NULL;checked(heif_context_get_primary_image_handle(ctx,&primary));
 struct heif_decoding_options *options=heif_decoding_options_alloc();if(!options)fail();options->strict_decoding=1;options->ignore_transformations=0;options->decoder_id="libde265";options->convert_hdr_to_8bit=1;options->num_codec_threads=1;
 struct heif_image *image=NULL;checked(heif_decode_image(primary,&image,heif_colorspace_RGB,heif_chroma_interleaved_RGBA,options));
 int w=heif_image_get_primary_width(image),h=heif_image_get_primary_height(image),stride=0;
 if(!pixels(w,h)||heif_image_get_bits_per_pixel_range(image,heif_channel_interleaved)!=8)fail();
 const unsigned char *plane=heif_image_get_plane_readonly(image,heif_channel_interleaved,&stride);if(!plane||stride<w*4||(uint64_t)stride*(uint64_t)h>192ULL*1024*1024)fail();
 for(int y=0;y<h;y++)write_all(output,plane+(size_t)y*(size_t)stride,(size_t)w*4);
 close(output);
 printf("{\"width\":%d,\"height\":%d,\"channels\":4,\"decoder\":\"libheif:%s/libde265\"}\n",w,h,heif_get_version());
 heif_image_release(image);heif_decoding_options_free(options);heif_image_handle_release(primary);heif_context_free(ctx);free(bytes);return 0;
}
