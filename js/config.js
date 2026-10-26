// ★ 설치 안내서 3단계: Firebase 콘솔에서 복사한 값을 아래에 붙여 넣으세요.
export const firebaseConfig = {
  apiKey: "AIzaSyCF0b1vz7y6NZ0ixRq9cQ4uQbPIFaqxT3E",
  authDomain: "english-speaking-tool-52216.firebaseapp.com",
  projectId: "english-speaking-tool-52216",
  storageBucket: "english-speaking-tool-52216.firebasestorage.app",
  messagingSenderId: "582622388776",
  appId: "1:582622388776:web:390bfc312dd10a394f0b1d",
};

// 로그인 버튼 표시 여부 (Microsoft 로그인은 설치 안내서 "부록"을 마친 뒤 true 로 바꾸세요)
export const loginOptions = {
  microsoft: false,
  google: true,
  // 학교 Microsoft 계정만 허용하려면 학교 테넌트 ID를 적으세요 (모르면 "organizations" 그대로)
  microsoftTenant: "organizations",
};

// 로그인할 수 있는 학교 이메일 주소 (이 주소로 끝나는 계정만 사용 가능)
// ★ 바꾸면 firestore.rules 의 schoolAccount() 도 똑같이 바꾸세요. 빈 목록 [] 이면 제한 없음
export const allowedDomains = ["yk.hs.kr"];

// 학생 기기 안에서 돌아가는 무료 음성 인식 AI (Whisper)
//  "Xenova/whisper-tiny.en" : 약 40MB, 빠름 (기본)
//  "Xenova/whisper-base.en" : 약 80MB, 더 정확하지만 느림 (최신 아이패드 권장)
export const asrModel = "Xenova/whisper-tiny.en";

// 다음 문장으로 넘어가는 기준: 저장한 완성도가 이 점수 "초과"여야 함 (60 → 61% 이상이어야 통과)
export const passScore = 60;

// 반 목록 기본값 (앱의 [설정] 탭에서 바꿀 수 있습니다)
export const defaultClasses = ["1반", "2반", "3반", "4반", "5반", "6반", "7반"];
