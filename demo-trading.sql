BEGIN;
CREATE TABLE IF NOT EXISTS public.kalshibot_demo_control (
 id integer PRIMARY KEY CHECK(id=1), stopped boolean NOT NULL DEFAULT true
);
INSERT INTO public.kalshibot_demo_control VALUES(1,true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.kalshibot_demo_attempts (
 ticker text PRIMARY KEY CHECK(ticker LIKE 'KXBTC15M-%'),
 client_order_id text UNIQUE NOT NULL,
 risk_day date NOT NULL,
 budget_cents integer NOT NULL CHECK(budget_cents BETWEEN 1 AND 500),
 status text NOT NULL CHECK(status IN ('RESERVED','UNKNOWN','SUBMITTED','NO_FILL','SETTLED')),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.kalshibot_demo_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kalshibot_demo_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kalshibot_demo_control,public.kalshibot_demo_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.kalshibot_demo_control,public.kalshibot_demo_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.kalshibot_demo_stop(p_stopped boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(733105);
 UPDATE public.kalshibot_demo_control SET stopped=p_stopped WHERE id=1;
END $$;

CREATE OR REPLACE FUNCTION public.kalshibot_demo_reserve(p_ticker text,p_client text,p_budget integer,p_payload jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
 PERFORM pg_advisory_xact_lock(733105);
 IF NOT EXISTS(SELECT 1 FROM public.kalshibot_demo_control WHERE id=1 AND stopped=false)
    THEN RAISE EXCEPTION 'Demo stopped'; END IF;
 IF p_budget IS NULL OR p_budget<1 OR p_budget>500 THEN RAISE EXCEPTION 'Invalid budget'; END IF;
 IF EXISTS(SELECT 1 FROM public.kalshibot_demo_attempts WHERE ticker=p_ticker) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.kalshibot_demo_attempts WHERE status IN ('RESERVED','UNKNOWN'))
    THEN RAISE EXCEPTION 'Unresolved submission'; END IF;
 IF (SELECT count(*) FROM public.kalshibot_demo_attempts WHERE risk_day=d)>=5
    THEN RAISE EXCEPTION 'Daily attempt limit'; END IF;
 IF (SELECT coalesce(sum(budget_cents),0) FROM public.kalshibot_demo_attempts
       WHERE risk_day=d OR status IN ('RESERVED','UNKNOWN','SUBMITTED'))+p_budget>1500
    THEN RAISE EXCEPTION 'Daily reservation and exposure limit'; END IF;
 INSERT INTO public.kalshibot_demo_attempts VALUES(p_ticker,p_client,d,p_budget,'RESERVED',p_payload,now());
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.kalshibot_demo_update(p_ticker text,p_status text,p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(733105);
 UPDATE public.kalshibot_demo_attempts
 SET status=p_status,payload=payload||p_payload WHERE ticker=p_ticker;
END $$;
REVOKE ALL ON FUNCTION public.kalshibot_demo_stop(boolean),
 public.kalshibot_demo_reserve(text,text,integer,jsonb),
 public.kalshibot_demo_update(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.kalshibot_demo_stop(boolean),
 public.kalshibot_demo_reserve(text,text,integer,jsonb),
 public.kalshibot_demo_update(text,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
