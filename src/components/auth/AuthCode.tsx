import {
  memo, useCallback, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { IS_TOUCH_ENV } from '../../util/browser/windowEnvironment';

import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';

import Icon from '../common/icons/Icon';
import TrackingMonkey from '../common/TrackingMonkey';
import InputText from '../ui/InputText';
import Loading from '../ui/Loading';

type StateProps = {
  auth: GlobalState['auth'];
  connectionState?: GlobalState['connectionState'];
};

const DEFAULT_CODE_LENGTH = 5;

const AuthCode = ({
  auth,
  connectionState,
}: StateProps) => {
  const {
    setAuthCode,
    returnToAuthPhoneNumber,
    clearAuthErrorKey,
  } = getActions();

  const {
    phoneNumber, isCodeViaApp, sentCodeInfo, floodWaitUntil, isLoading, errorKey,
  } = auth;

  const codeLength = sentCodeInfo?.length || DEFAULT_CODE_LENGTH;
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();

  const [code, setCode] = useState<string>('');
  const [isTracking, setIsTracking] = useState(false);
  const [trackingDirection, setTrackingDirection] = useState(1);
  const [remainingFloodSeconds, setRemainingFloodSeconds] = useState(0);

  useEffect(() => {
    if (!floodWaitUntil) {
      setRemainingFloodSeconds(0);
      return undefined;
    }

    const updateRemaining = () => {
      const next = Math.max(0, Math.ceil((floodWaitUntil - Date.now()) / 1000));
      setRemainingFloodSeconds(next);
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [floodWaitUntil]);

  useEffect(() => {
    if (!IS_TOUCH_ENV) {
      inputRef.current!.focus();
    }
  }, []);

  useHistoryBack({
    isActive: true,
    onBack: returnToAuthPhoneNumber,
  });

  const onCodeChange = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    if (errorKey) {
      clearAuthErrorKey();
    }

    const { currentTarget: target } = e;
    target.value = target.value.replace(/[^\d]+/g, '').slice(0, codeLength);

    if (target.value === code) {
      return;
    }

    setCode(target.value);

    if (!isTracking) {
      setIsTracking(true);
    } else if (!target.value.length) {
      setIsTracking(false);
    }

    if (code && code.length > target.value.length) {
      setTrackingDirection(-1);
    } else {
      setTrackingDirection(1);
    }

    if (target.value.length === codeLength) {
      setAuthCode({ code: target.value });
    }
  }, [errorKey, code, isTracking, codeLength]);

  function handleReturnToAuthPhoneNumber() {
    returnToAuthPhoneNumber();
  }

  const wssStatusText = connectionState === 'connectionStateReady'
    ? lang('AuthWssStatusReady')
    : connectionState === 'connectionStateBroken'
      ? lang('AuthWssStatusBroken')
      : lang('AuthWssStatusConnecting');

  return (
    <div id="auth-code-form" className="custom-scroll">
      <div className="auth-form">
        <TrackingMonkey
          code={code}
          codeLength={codeLength}
          isTracking={isTracking}
          trackingDirection={trackingDirection}
        />
        <h1>
          {phoneNumber}
          <div
            className="auth-number-edit div-button"
            onClick={handleReturnToAuthPhoneNumber}
            role="button"
            tabIndex={0}
            title={lang('WrongNumber')}
            aria-label={lang('WrongNumber')}
          >
            <Icon name="edit" />
          </div>
        </h1>
        <p className="note">
          {sentCodeInfo?.type === 'SentCodeTypeEmailCode' && sentCodeInfo.emailPattern
            ? lang('AuthEmailCodeSentNote', { email: sentCodeInfo.emailPattern })
            : sentCodeInfo?.type === 'SentCodeTypeSetUpEmailRequired'
              ? lang('AuthEmailSetupRequiredNote')
              : lang(isCodeViaApp ? 'SentAppCode' : 'LoginJustSentSms', undefined, {
                withNodes: true,
                withMarkdown: true,
              })}
        </p>
        <div className="auth-diagnostics" dir="rtl">
          <div className="auth-diagnostics-row">
            <span className="auth-diagnostics-badge">{wssStatusText}</span>
            {sentCodeInfo && (
              <span className="auth-diagnostics-badge">
                {lang('AuthSentCodeTypeNotice', { type: sentCodeInfo.type })}
              </span>
            )}
          </div>
          <p className="auth-diagnostics-note">{lang('AuthSendCodeDeliveryCaveat')}</p>
          {remainingFloodSeconds > 0 && (
            <p className="auth-diagnostics-warning">
              {lang('AuthFloodWaitActive', { seconds: remainingFloodSeconds })}
            </p>
          )}
        </div>
        <InputText
          ref={inputRef}
          id="sign-in-code"
          label={lang('Code')}
          onInput={onCodeChange}
          value={code}
          error={errorKey && lang.withRegular(errorKey)}
          autoComplete="off"
          inputMode="numeric"
        />
        {isLoading && <Loading />}
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => ({
    auth: global.auth,
    connectionState: global.connectionState,
  }),
)(AuthCode));
