import { SignJWT, jwtVerify } from 'jose';

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);

const CHALLENGE_AUD = '2fa-challenge';
const ENROLMENT_AUD = '2fa-enrol';
const TASK_ACTION_AUD = 'task-action';
const SHORT_EXP = '5m';

export async function signToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('30d')
    .sign(await secret());
}

export async function verifyToken(token) {
  const { payload } = await jwtVerify(token, await secret());
  if (payload.aud === CHALLENGE_AUD || payload.aud === ENROLMENT_AUD || payload.aud === TASK_ACTION_AUD) {
    throw new Error('Restricted-scope token cannot be used as a session token');
  }
  return payload;
}

export async function signChallengeToken({ email }) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(CHALLENGE_AUD)
    .setExpirationTime(SHORT_EXP)
    .sign(await secret());
}

export async function verifyChallengeToken(token) {
  const { payload } = await jwtVerify(token, await secret(), { audience: CHALLENGE_AUD });
  return payload;
}

export async function signEnrolmentToken({ email }) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(ENROLMENT_AUD)
    .setExpirationTime(SHORT_EXP)
    .sign(await secret());
}

export async function verifyEnrolmentToken(token) {
  const { payload } = await jwtVerify(token, await secret(), { audience: ENROLMENT_AUD });
  return payload;
}

// One-click email actions for tasks ("Mark as done" from reminder emails).
// 14d window keeps the link useful for slow inbox readers but limits replay.
export async function signTaskActionToken({ taskId, email, action }) {
  return new SignJWT({ taskId, email, act: action })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(TASK_ACTION_AUD)
    .setExpirationTime('14d')
    .sign(await secret());
}

export async function verifyTaskActionToken(token) {
  const { payload } = await jwtVerify(token, await secret(), { audience: TASK_ACTION_AUD });
  return payload;
}
