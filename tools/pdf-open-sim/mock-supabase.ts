// The real App and annotation controller run against this controllable account in the test.
const sim = () => (globalThis as any).__pdfOpenSim;
export const cloudConfigured = true;
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: sim().user ? { user: sim().user } : null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => { sim().user = null; },
  },
};
export const watchItemCapabilities = async () => ({ deletions: true, sources: true });
export const fetchCloudVideos = async () => sim().videos.map((record: object) => ({ ...record }));
export const fetchLibraryPdfs = async () => sim().pdfs.map((item: object) => ({ ...item }));
export const fetchPdfTrashMap = async () => ({ ...sim().trash });
export const fetchPdfActivity = async () => [];
export const fetchCloudSyncLedger = async () => ({ available: true, ledger: { lessons: {}, pdfs: { ...sim().ledgerPdfs } } });
export const pushCloudSyncLedger = async () => ({ available: true, ledger: { lessons: {}, pdfs: {} } });
export const subscribeCloudSyncLedger = () => () => {};
export const probeAnnotationTables = async () => [];
export const fetchCloudAnnotations = async () => null;
export const saveCloudAnnotations = async () => Date.now();
export const subscribeCloudAnnotations = () => () => {};
export const isMissingTableError = () => false;
export const isLibraryPath = (path?: string) => Boolean(path?.includes('/library/'));
export async function saveCloudVideo(_user: string, record: any) {
  const state = sim();
  state.videos = [...state.videos.filter((entry: any) => entry.videoId !== record.videoId), { ...record }];
}
export const clearCloudVideoDeletion = async () => {};
export const deleteCloudLessonAnnotations = async () => {};
export const deleteCloudVideo = async () => {};
export const deleteLibraryPdf = async () => {};
export const restoreLibraryPdf = async () => {};
export const savePdfActivity = async () => {};
export const trashLibraryPdf = async () => {};
export const updateLibraryPdf = async () => {};
export const createLibraryPdf = async () => { throw new Error('Not used in this test'); };
export function createPdfSignedUrl(path: string) {
  return new Promise<string>((resolve, reject) => {
    sim().signs.push({ path, resolve, reject });
    sim().events.push(`sign:${path}`);
  });
}
export function uploadCloudPdf(_user: string, videoId: string, file: File) {
  return new Promise<string>((resolve, reject) => {
    sim().uploads.push({ videoId, file, resolve, reject });
  });
}
export async function deleteCloudPdf(path: string) { sim().deletedPaths.push(path); }
