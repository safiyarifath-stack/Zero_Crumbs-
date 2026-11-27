/// <reference types="google.maps" />
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  Building2,
  CheckCircle2,
  Crosshair,
  ExternalLink,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  RefreshCw,
  Search,
} from 'lucide-react';
import { auth } from '../firebase';
import type {
  NearbyCharityOrganisation,
  SelectedCharityOrganisation,
} from '../types';

export interface PickupLocationValue {
  address: string;
  latitude: number;
  longitude: number;
  placeId?: string;
  confirmed: boolean;
}

interface DonationPickupMapSelectorProps {
  value: PickupLocationValue | null;
  selectedOrganisation: SelectedCharityOrganisation | null;
  onChangeLocation: (next: PickupLocationValue) => void;
  onSelectOrganisation: (org: SelectedCharityOrganisation | null) => void;
}

const DEFAULT_MAP_CENTER = { lat: 20.5937, lng: 78.9629 };
const DEFAULT_MAP_ZOOM = 5;

function formatDistance(meters?: number): string {
  if (typeof meters !== 'number' || Number.isNaN(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)} m away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function emitQuotaExceededIfNeeded(status: number, body: { quotaExceeded?: boolean; error?: string }) {
  if (
    status === 429 ||
    body?.quotaExceeded ||
    (body?.error && body.error.toLowerCase().includes('quota'))
  ) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
}

function MapCameraController({
  target,
  zoom,
}: {
  target: { lat: number; lng: number } | null;
  zoom?: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map || !target) return;
    map.panTo(target);
    if (typeof zoom === 'number') {
      const currentZoom = map.getZoom() ?? 0;
      if (currentZoom < zoom) {
        map.setZoom(zoom);
      }
    }
  }, [map, target, zoom]);

  return null;
}

function AddressAutocompleteInput({
  searchQuery,
  setSearchQuery,
  disabled,
  searching,
  onPickSuggestion,
  onSubmitSearch,
}: {
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  disabled: boolean;
  searching: boolean;
  onPickSuggestion: (coords: {
    lat: number;
    lng: number;
    address: string;
    placeId?: string;
  }) => void;
  onSubmitSearch: () => void;
}) {
  const placesLib = useMapsLibrary('places');
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompleteSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  useEffect(() => {
    if (!placesLib || disabled) return;
    const trimmed = searchQuery.trim();
    if (trimmed.length < 3) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
        if (!sessionTokenRef.current) {
          sessionTokenRef.current = new AutocompleteSessionToken();
        }
        setLoadingSuggestions(true);
        const res = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: trimmed,
          sessionToken: sessionTokenRef.current,
        });
        if (!cancelled) {
          setSuggestions(res.suggestions || []);
          setDropdownOpen(true);
        }
      } catch {
        if (!cancelled) {
          setSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingSuggestions(false);
        }
      }
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [placesLib, searchQuery, disabled]);

  const handleSelectSuggestion = useCallback(
    async (suggestion: google.maps.places.AutocompleteSuggestion) => {
      if (!placesLib || !suggestion.placePrediction) return;
      try {
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['id', 'formattedAddress', 'displayName', 'location'],
        });
        const loc = place.location;
        if (loc) {
          const lat = loc.lat();
          const lng = loc.lng();
          const address =
            place.formattedAddress ||
            suggestion.placePrediction.text?.text ||
            searchQuery;
          setSearchQuery(address);
          onPickSuggestion({
            lat,
            lng,
            address,
            placeId: place.id || undefined,
          });
        }
      } catch {
        onSubmitSearch();
      } finally {
        sessionTokenRef.current = null;
        setSuggestions([]);
        setDropdownOpen(false);
      }
    },
    [placesLib, onPickSuggestion, onSubmitSearch, searchQuery, setSearchQuery]
  );

  return (
    <div className="relative flex-1">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-[#6B7A70] dark:text-[#90A498] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            disabled={disabled}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setDropdownOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setDropdownOpen(false);
                onSubmitSearch();
              }
            }}
            placeholder="Search street, neighborhood, landmark, or postal code"
            className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED] disabled:bg-[#F5F6F2] dark:disabled:bg-[#17211C] disabled:text-[#6B7A70] dark:disabled:text-[#869B8F]"
          />
        </div>
        <button
          type="button"
          disabled={disabled || searching || !searchQuery.trim()}
          onClick={() => {
            setDropdownOpen(false);
            onSubmitSearch();
          }}
          className="px-3.5 py-2.5 rounded-xl bg-[#EEF3EC] dark:bg-[#1B3328] text-[#1B4332] dark:text-[#82C9A5] text-xs font-medium hover:bg-[#DFEBDD] dark:hover:bg-[#244234] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5"
        >
          {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Find
        </button>
      </div>

      {dropdownOpen && !disabled && (suggestions.length > 0 || loadingSuggestions) && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-30 bg-white dark:bg-[#17211C] border border-[#DCE0D8] dark:border-[#2B3B32] rounded-xl shadow-lg overflow-hidden max-h-56 overflow-y-auto">
          {loadingSuggestions && suggestions.length === 0 ? (
            <div className="px-3.5 py-2.5 text-xs text-[#5A6A60] dark:text-[#9CB0A4] flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Searching addresses...
            </div>
          ) : (
            suggestions.map((s, idx) => {
              const label = s.placePrediction?.text?.text || '';
              if (!label) return null;
              return (
                <button
                  key={`${s.placePrediction?.placeId || idx}`}
                  type="button"
                  onClick={() => void handleSelectSuggestion(s)}
                  className="w-full text-left px-3.5 py-2.5 text-xs text-[#1A2820] dark:text-[#EBF2ED] hover:bg-[#EEF3EC] dark:hover:bg-[#1F2D25] border-b last:border-b-0 border-[#ECEEE8] dark:border-[#24322B] flex items-start gap-2 cursor-pointer"
                >
                  <MapPin className="w-3.5 h-3.5 text-[#1B4332] dark:text-[#82C9A5] mt-0.5 shrink-0" />
                  <span>{label}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export function DonationPickupMapSelector({
  value,
  selectedOrganisation,
  onChangeLocation,
  onSelectOrganisation,
}: DonationPickupMapSelectorProps) {
  const envApiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
  const [apiKey, setApiKey] = useState<string>(envApiKey);
  const [configLoaded, setConfigLoaded] = useState<boolean>(Boolean(envApiKey));

  const [searchQuery, setSearchQuery] = useState<string>(value?.address || '');
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number }>(
    value ? { lat: value.latitude, lng: value.longitude } : DEFAULT_MAP_CENTER
  );
  const [desiredZoom, setDesiredZoom] = useState<number>(value ? 15 : DEFAULT_MAP_ZOOM);

  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [mapError, setMapError] = useState('');
  const [embeddedGeoBlocked, setEmbeddedGeoBlocked] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [charities, setCharities] = useState<NearbyCharityOrganisation[]>([]);
  const [searchingCharities, setSearchingCharities] = useState(false);
  const [charityError, setCharityError] = useState('');
  const [hasSearchedCharities, setHasSearchedCharities] = useState(false);
  const [activeInfoPlaceId, setActiveInfoPlaceId] = useState<string | null>(null);

  useEffect(() => {
    if (envApiKey) return;
    let active = true;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const resp = await fetch('/api/maps/config', { headers });
        if (!resp.ok) {
          if (active) setConfigLoaded(true);
          return;
        }
        const data = (await resp.json()) as { configured?: boolean; apiKey?: string };
        if (active) {
          if (data.configured && data.apiKey) {
            setApiKey(data.apiKey);
          }
          setConfigLoaded(true);
        }
      } catch {
        if (active) setConfigLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [envApiKey]);

  const fetchNearbyCharities = useCallback(
    async (lat: number, lng: number) => {
      setSearchingCharities(true);
      setCharityError('');
      setHasSearchedCharities(true);
      try {
        const headers = await getAuthHeaders();
        const resp = await fetch('/api/maps/nearby-charities', {
          method: 'POST',
          headers,
          body: JSON.stringify({ lat, lng, radiusMeters: 15000 }),
        });
        const data = (await resp.json()) as {
          organisations?: NearbyCharityOrganisation[];
          error?: string;
          quotaExceeded?: boolean;
        };
        if (!resp.ok) {
          emitQuotaExceededIfNeeded(resp.status, data);
          setCharityError(
            data.error || 'Could not load nearby charity organisations right now.'
          );
          setCharities([]);
          return;
        }
        setCharities(Array.isArray(data.organisations) ? data.organisations : []);
      } catch {
        setCharityError('Network error while searching nearby charity organisations.');
        setCharities([]);
      } finally {
        setSearchingCharities(false);
      }
    },
    []
  );

  // If editing an existing confirmed donation that already has coordinates, pre-load nearby charities once
  const initialFetchedRef = useRef(false);
  useEffect(() => {
    if (
      configLoaded &&
      apiKey &&
      value?.confirmed &&
      !initialFetchedRef.current
    ) {
      initialFetchedRef.current = true;
      void fetchNearbyCharities(value.latitude, value.longitude);
    }
  }, [configLoaded, apiKey, value, fetchNearbyCharities]);

  const reverseGeocodeCoords = useCallback(
    async (lat: number, lng: number) => {
      if (!isMountedRef.current) return;
      setGeocoding(true);
      setMapError('');
      setEmbeddedGeoBlocked(false);
      setMapCenter({ lat, lng });
      setDesiredZoom(16);

      const fallbackCoordsLabel = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

      const tryClientGeocoder = async (): Promise<{
        address: string;
        placeId?: string;
      } | null> => {
        if (typeof window === 'undefined' || !window.google?.maps?.Geocoder) {
          return null;
        }
        try {
          const geocoder = new window.google.maps.Geocoder();
          const geoRes = await geocoder.geocode({ location: { lat, lng } });
          const best = geoRes.results?.[0];
          if (best?.formatted_address) {
            return {
              address: best.formatted_address,
              placeId: best.place_id || undefined,
            };
          }
        } catch {
          // Ignore client geocoder fallback error
        }
        return null;
      };

      try {
        const headers = await getAuthHeaders();
        const resp = await fetch('/api/maps/reverse-geocode', {
          method: 'POST',
          headers,
          body: JSON.stringify({ lat, lng }),
        });
        const data = (await resp.json()) as {
          formattedAddress?: string;
          placeId?: string;
          noAddressFound?: boolean;
          error?: string;
          quotaExceeded?: boolean;
        };
        if (!isMountedRef.current) return;

        if (!resp.ok) {
          emitQuotaExceededIfNeeded(resp.status, data);
          const clientHit = await tryClientGeocoder();
          if (!isMountedRef.current) return;
          const address = clientHit?.address || fallbackCoordsLabel;
          setSearchQuery(address);
          onChangeLocation({
            address,
            latitude: lat,
            longitude: lng,
            placeId: clientHit?.placeId,
            confirmed: false,
          });
          if (!clientHit) {
            setMapError(data.error || 'Could not resolve the street address for this pin.');
          }
          return;
        }

        let resolvedAddress =
          data.formattedAddress && data.formattedAddress.trim()
            ? data.formattedAddress.trim()
            : '';
        let resolvedPlaceId = data.placeId || undefined;

        if (!resolvedAddress) {
          const clientHit = await tryClientGeocoder();
          if (!isMountedRef.current) return;
          if (clientHit?.address) {
            resolvedAddress = clientHit.address;
            resolvedPlaceId = resolvedPlaceId || clientHit.placeId;
          }
        }

        const finalAddress = resolvedAddress || fallbackCoordsLabel;
        setSearchQuery(finalAddress);
        onChangeLocation({
          address: finalAddress,
          latitude: lat,
          longitude: lng,
          placeId: resolvedPlaceId,
          confirmed: false,
        });
        if (!resolvedAddress && data.noAddressFound) {
          setMapError(
            'Pin placed, but no street address was returned for that exact spot. Adjust the pin slightly closer to a road.'
          );
        }
      } catch {
        if (!isMountedRef.current) return;
        const clientHit = await tryClientGeocoder();
        if (!isMountedRef.current) return;
        const address = clientHit?.address || fallbackCoordsLabel;
        setSearchQuery(address);
        onChangeLocation({
          address,
          latitude: lat,
          longitude: lng,
          placeId: clientHit?.placeId,
          confirmed: false,
        });
        if (!clientHit) {
          setMapError('Could not fetch the street address. Pin coordinates were kept—please verify or adjust manually.');
        }
      } finally {
        if (isMountedRef.current) {
          setGeocoding(false);
        }
      }
    },
    [onChangeLocation]
  );

  const handleGeocodeSearch = useCallback(async () => {
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) {
      setMapError('Enter a street address, area, or postal code to search.');
      return;
    }
    setGeocoding(true);
    setMapError('');
    setEmbeddedGeoBlocked(false);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch('/api/maps/geocode', {
        method: 'POST',
        headers,
        body: JSON.stringify({ address: trimmed }),
      });
      const data = (await resp.json()) as {
        lat?: number;
        lng?: number;
        formattedAddress?: string;
        placeId?: string;
        error?: string;
        quotaExceeded?: boolean;
      };
      if (!resp.ok || typeof data.lat !== 'number' || typeof data.lng !== 'number') {
        emitQuotaExceededIfNeeded(resp.status, data);
        setMapError(data.error || 'Address not found. Try a nearby landmark or drop the pin manually.');
        return;
      }
      const nextAddress = data.formattedAddress || trimmed;
      setSearchQuery(nextAddress);
      setMapCenter({ lat: data.lat, lng: data.lng });
      setDesiredZoom(16);
      onChangeLocation({
        address: nextAddress,
        latitude: data.lat,
        longitude: data.lng,
        placeId: data.placeId || undefined,
        confirmed: false,
      });
    } catch {
      setMapError('Could not search that address right now. Please try again.');
    } finally {
      setGeocoding(false);
    }
  }, [searchQuery, onChangeLocation]);

  const handleUseCurrentLocation = useCallback(() => {
    setMapError('');
    setEmbeddedGeoBlocked(false);

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setMapError(
        'Geolocation is not supported by your browser. Please search your address or click on the map manually.'
      );
      return;
    }

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setMapError(
        'Current location detection requires HTTPS or localhost. Open this app over HTTPS (or localhost), or search your address manually.'
      );
      return;
    }

    const applyGeolocationError = (err: GeolocationPositionError) => {
      if (!isMountedRef.current) return;
      setLocating(false);
      const rawMsg = (err.message || '').toLowerCase();

      if (err.code === err.PERMISSION_DENIED) {
        const isPolicyBlocked =
          rawMsg.includes('permissions policy') ||
          rawMsg.includes('feature policy') ||
          rawMsg.includes('disabled in this document');
        const isInsecureOrigin = rawMsg.includes('secure origin');

        if (isPolicyBlocked) {
          const inIframe = typeof window !== 'undefined' && window.self !== window.top;
          setEmbeddedGeoBlocked(inIframe);
          setMapError(
            inIframe
              ? 'Location access is blocked by the embedded preview frame’s permissions policy. Open this app in a full HTTPS browser tab to use GPS detection, or search your address / drop a pin manually below.'
              : 'Location access is blocked by browser permissions policy. Enable location permissions or search your address manually.'
          );
        } else if (isInsecureOrigin) {
          setMapError(
            'Current location requires HTTPS or localhost. Open the app over HTTPS (or localhost), or search your address manually.'
          );
        } else {
          setMapError(
            'Location permission was denied. Click the lock or site-settings icon in your browser’s address bar to allow Location access and retry, or search your address / drop a pin manually.'
          );
        }
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        setMapError(
          'Your location is currently unavailable (GPS or network positioning could not determine your coordinates). Check that device location services are enabled, or search your address / drop a pin manually.'
        );
      } else if (err.code === err.TIMEOUT) {
        setMapError(
          'Location request timed out before coordinates were returned. Please try again, or search your address / drop a pin manually.'
        );
      } else {
        setMapError(
          'Could not detect your current location. Please search your address or click on the map manually.'
        );
      }
    };

    const handlePositionSuccess = (pos: GeolocationPosition) => {
      if (!isMountedRef.current) return;
      const { latitude, longitude } = pos.coords;
      setLocating(false);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        setMapError('Received invalid coordinates from browser geolocation. Please drop a pin manually.');
        return;
      }

      // Immediately center map and place marker on retrieved coordinates while reverse-geocoding runs
      setMapCenter({ lat: latitude, lng: longitude });
      setDesiredZoom(16);
      onChangeLocation({
        address: `Detecting street address (${latitude.toFixed(5)}, ${longitude.toFixed(5)})...`,
        latitude,
        longitude,
        confirmed: false,
      });

      void reverseGeocodeCoords(latitude, longitude);
    };

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      handlePositionSuccess,
      (err) => {
        if (!isMountedRef.current) return;
        // On desktop/laptop devices without GPS hardware, high-accuracy mode can fail with
        // POSITION_UNAVAILABLE or TIMEOUT; retry once with standard network/Wi-Fi positioning.
        if (err.code === err.POSITION_UNAVAILABLE || err.code === err.TIMEOUT) {
          navigator.geolocation.getCurrentPosition(
            handlePositionSuccess,
            applyGeolocationError,
            { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
          );
          return;
        }
        applyGeolocationError(err);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }, [onChangeLocation, reverseGeocodeCoords]);

  const handleConfirmLocation = () => {
    if (!value) {
      setMapError('Please search an address, detect your location, or drop a pin on the map first.');
      return;
    }
    setMapError('');
    onChangeLocation({
      ...value,
      confirmed: true,
    });
    void fetchNearbyCharities(value.latitude, value.longitude);
  };

  const handleUnlockLocation = () => {
    if (!value) return;
    onChangeLocation({
      ...value,
      confirmed: false,
    });
  };

  if (!configLoaded) {
    return (
      <div className="p-4 rounded-xl border border-[#DCE0D8] dark:border-[#2B3B32] bg-[#FAF9F6] dark:bg-[#0F1713] flex items-center gap-2.5 text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
        <Loader2 className="w-4 h-4 animate-spin text-[#1B4332] dark:text-[#82C9A5]" />
        Loading interactive Google Maps pickup selector...
      </div>
    );
  }

  if (!apiKey) {
    return (
      <div className="p-4 rounded-xl border border-[#EBC6BA] dark:border-[#6B3232] bg-[#FDF2EC] dark:bg-[#331B1B] text-xs text-[#9E2F2F] dark:text-[#FCA5A5] space-y-1.5">
        <p className="font-semibold">Google Maps API Key Not Available</p>
        <p>
          To select an exact pickup pin and search genuine nearby charities via Google Places,
          ensure <code className="font-mono">GOOGLE_MAPS_API_KEY</code> is set in AI Studio
          Secrets and restart the app server.
        </p>
      </div>
    );
  }

  const isConfirmed = Boolean(value?.confirmed);

  return (
    <APIProvider apiKey={apiKey}>
      <div className="space-y-4">
        {/* Step 1: Search / Use Current Location */}
        <div className="space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                Exact Pickup Location (Google Maps) *
              </p>
              <p className="text-[11px] text-[#5A6A60] dark:text-[#9CB0A4]">
                Search an address, use your current GPS location, or click/drag the map pin.
              </p>
            </div>
            <button
              type="button"
              disabled={isConfirmed || locating || geocoding}
              onClick={handleUseCurrentLocation}
              className="px-3 py-2 rounded-xl border border-[#C7DBC9] dark:border-[#2E4D3E] bg-[#EEF3EC] dark:bg-[#1B3328] text-[#1B4332] dark:text-[#82C9A5] text-xs font-medium hover:bg-[#DFEBDD] dark:hover:bg-[#244234] transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              {locating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Crosshair className="w-3.5 h-3.5" />
              )}
              {locating ? 'Locating...' : 'Use My Current Location'}
            </button>
          </div>

          <AddressAutocompleteInput
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            disabled={isConfirmed}
            searching={geocoding}
            onPickSuggestion={({ lat, lng, address, placeId }) => {
              setMapError('');
              setEmbeddedGeoBlocked(false);
              setMapCenter({ lat, lng });
              setDesiredZoom(16);
              onChangeLocation({
                address,
                latitude: lat,
                longitude: lng,
                placeId,
                confirmed: false,
              });
            }}
            onSubmitSearch={() => void handleGeocodeSearch()}
          />

          {mapError && (
            <div
              role="alert"
              className="p-3 rounded-xl bg-[#FDF2EC] dark:bg-[#331B1B] border border-[#EBC6BA] dark:border-[#6B3232] text-xs text-[#9E2F2F] dark:text-[#FCA5A5] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
            >
              <span>{mapError}</span>
              {embeddedGeoBlocked && typeof window !== 'undefined' && (
                <a
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#17211C] border border-[#EBC6BA] dark:border-[#6B3232] text-[11px] font-semibold text-[#9E2F2F] dark:text-[#FCA5A5] hover:bg-[#FAF9F6] dark:hover:bg-[#1F2D25] shrink-0 self-start sm:self-auto"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open in New Tab
                </a>
              )}
            </div>
          )}

          {/* Interactive Google Map */}
          <div className="relative w-full h-[300px] sm:h-[340px] rounded-xl overflow-hidden border border-[#DCE0D8] dark:border-[#2B3B32]">
            <GoogleMap
              mapId="DEMO_MAP_ID"
              internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              defaultCenter={mapCenter}
              defaultZoom={desiredZoom}
              gestureHandling="greedy"
              streetViewControl={false}
              mapTypeControl={false}
              onClick={(ev) => {
                if (isConfirmed) return;
                const latLng = ev.detail?.latLng;
                if (latLng) {
                  void reverseGeocodeCoords(latLng.lat, latLng.lng);
                }
              }}
            >
              <MapCameraController target={mapCenter} zoom={desiredZoom} />

              {value && (
                <AdvancedMarker
                  position={{ lat: value.latitude, lng: value.longitude }}
                  draggable={!isConfirmed}
                  title="Food Pickup Location"
                  onDragEnd={(ev) => {
                    if (isConfirmed) return;
                    const lat = ev.latLng?.lat();
                    const lng = ev.latLng?.lng();
                    if (typeof lat === 'number' && typeof lng === 'number') {
                      void reverseGeocodeCoords(lat, lng);
                    }
                  }}
                >
                  <Pin
                    background="#1B4332"
                    borderColor="#143325"
                    glyphColor="#FFFFFF"
                    scale={1.15}
                  />
                </AdvancedMarker>
              )}

              {charities.map((org) => {
                const isSelected = selectedOrganisation?.placeId === org.placeId;
                return (
                  <React.Fragment key={org.placeId}>
                    <AdvancedMarker
                      position={{ lat: org.latitude, lng: org.longitude }}
                      title={org.name}
                      onClick={() => setActiveInfoPlaceId(org.placeId)}
                    >
                      <Pin
                        background={isSelected ? '#2D6A4F' : '#B56A1B'}
                        borderColor={isSelected ? '#1B4332' : '#7D460B'}
                        glyphColor="#FFFFFF"
                        scale={isSelected ? 1.15 : 0.95}
                      />
                    </AdvancedMarker>

                    {activeInfoPlaceId === org.placeId && (
                      <InfoWindow
                        position={{ lat: org.latitude, lng: org.longitude }}
                        onCloseClick={() => setActiveInfoPlaceId(null)}
                      >
                        <div className="max-w-[220px] p-1 space-y-1 text-[#1A2820]">
                          <p className="text-xs font-semibold">{org.name}</p>
                          <p className="text-[11px] text-[#5A6A60]">{org.address}</p>
                          <p className="text-[11px] font-medium text-[#1B4332]">
                            {formatDistance(org.distanceMeters)}
                          </p>
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => {
                                onSelectOrganisation(org);
                                setActiveInfoPlaceId(null);
                              }}
                              className="px-2.5 py-1 rounded-lg bg-[#1B4332] text-white text-[11px] font-medium cursor-pointer"
                            >
                              {isSelected ? 'Selected' : 'Select'}
                            </button>
                            {org.directionsUri && (
                              <a
                                href={org.directionsUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-[#1B4332] underline font-medium"
                              >
                                Directions
                              </a>
                            )}
                          </div>
                        </div>
                      </InfoWindow>
                    )}
                  </React.Fragment>
                );
              })}
            </GoogleMap>

            {geocoding && (
              <div className="absolute top-3 left-3 z-20 px-3 py-1.5 rounded-xl bg-white/95 dark:bg-[#17211C]/95 border border-[#DCE0D8] dark:border-[#2B3B32] shadow-sm text-xs text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1B4332] dark:text-[#82C9A5]" />
                Fetching address...
              </div>
            )}
          </div>

          {/* Selected Pin Address & Confirmation Bar */}
          <div
            className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
              isConfirmed
                ? 'bg-[#EEF3EC] dark:bg-[#1B3328] border-[#C7DBC9] dark:border-[#2E4D3E]'
                : 'bg-[#FAF9F6] dark:bg-[#0F1713] border-[#DCE0D8] dark:border-[#2B3B32]'
            }`}
          >
            <div className="space-y-0.5 min-w-0">
              {value ? (
                <>
                  <p className="text-xs font-semibold text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-[#1B4332] dark:text-[#82C9A5] shrink-0" />
                    <span>{isConfirmed ? 'Confirmed Pickup Address' : 'Selected Pin Address'}</span>
                  </p>
                  <p className="text-xs text-[#34443A] dark:text-[#B8C7BE] break-words">
                    {value.address}
                  </p>
                  <p className="text-[11px] font-mono text-[#6B7A70] dark:text-[#869B8F] tabular-nums">
                    Coordinates: {value.latitude.toFixed(6)}, {value.longitude.toFixed(6)}
                  </p>
                </>
              ) : (
                <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                  Click anywhere on the map or search an address above to drop your pickup pin.
                </p>
              )}
            </div>

            {value && (
              <div className="shrink-0 flex items-center gap-2">
                {isConfirmed ? (
                  <button
                    type="button"
                    onClick={handleUnlockLocation}
                    className="px-3.5 py-2 rounded-xl bg-white dark:bg-[#17211C] border border-[#C7DBC9] dark:border-[#2E4D3E] text-xs font-medium text-[#1B4332] dark:text-[#82C9A5] hover:bg-[#FAF9F6] dark:hover:bg-[#1F2D25] cursor-pointer whitespace-nowrap"
                  >
                    Change Location
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={geocoding || locating}
                    onClick={handleConfirmLocation}
                    className="px-4 py-2 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60 whitespace-nowrap"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Confirm Pickup Location
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Nearby Genuine Charity Organisations */}
        {isConfirmed && (
          <div className="space-y-3 pt-2 border-t border-[#ECEEE8] dark:border-[#24322B]">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-[#1B4332] dark:text-[#82C9A5]" />
                  Nearby Verified Charity Organisations (Google Places)
                </h3>
                <p className="text-[11px] text-[#5A6A60] dark:text-[#9CB0A4]">
                  Genuine NGOs, food banks, orphanages, and community kitchens near your pickup pin.
                </p>
              </div>
              <button
                type="button"
                disabled={searchingCharities}
                onClick={() => value && void fetchNearbyCharities(value.latitude, value.longitude)}
                className="px-3 py-1.5 rounded-xl border border-[#DCE0D8] dark:border-[#2B3B32] bg-white dark:bg-[#17211C] text-xs font-medium text-[#34443A] dark:text-[#B8C7BE] hover:bg-[#F4F5F2] dark:hover:bg-[#1F2D25] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 self-start sm:self-auto"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${searchingCharities ? 'animate-spin' : ''}`} />
                Refresh Nearby
              </button>
            </div>

            {searchingCharities ? (
              <div className="p-5 rounded-xl border border-[#DCE0D8] dark:border-[#2B3B32] bg-[#FAF9F6] dark:bg-[#0F1713] flex items-center justify-center gap-2 text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                <Loader2 className="w-4 h-4 animate-spin text-[#1B4332] dark:text-[#82C9A5]" />
                Searching genuine nearby charity organisations around your pickup pin...
              </div>
            ) : charityError ? (
              <div className="p-3.5 rounded-xl border border-[#EBC6BA] dark:border-[#6B3232] bg-[#FDF2EC] dark:bg-[#331B1B] text-xs text-[#9E2F2F] dark:text-[#FCA5A5] flex items-center justify-between gap-2">
                <span>{charityError}</span>
                <button
                  type="button"
                  onClick={() => value && void fetchNearbyCharities(value.latitude, value.longitude)}
                  className="px-3 py-1.5 rounded-lg bg-white dark:bg-[#17211C] border border-[#EBC6BA] dark:border-[#6B3232] font-medium cursor-pointer shrink-0"
                >
                  Retry
                </button>
              </div>
            ) : hasSearchedCharities && charities.length === 0 ? (
              <div className="p-4 rounded-xl border border-[#DCE0D8] dark:border-[#2B3B32] bg-[#FAF9F6] dark:bg-[#0F1713] text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                No nearby charity organisations were returned by Google Places within 15 km of this
                pin. You can still publish your donation listing or adjust your pickup location.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                {charities.map((org) => {
                  const isSelected = selectedOrganisation?.placeId === org.placeId;
                  return (
                    <div
                      key={org.placeId}
                      className={`p-3.5 rounded-xl border transition-colors ${
                        isSelected
                          ? 'bg-[#EEF3EC] dark:bg-[#1B3328] border-[#1B4332] dark:border-[#52B788]'
                          : 'bg-white dark:bg-[#17211C] border-[#E5E7E2] dark:border-[#27362E] hover:border-[#C7DBC9] dark:hover:border-[#2E4D3E]'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                              {org.name}
                            </p>
                            {org.category && (
                              <span className="text-[11px] font-medium text-[#52796F] dark:text-[#82C9A5] bg-[#F2F4EF] dark:bg-[#1F2D25] px-2 py-0.5 rounded-md">
                                {org.category}
                              </span>
                            )}
                            {typeof org.distanceMeters === 'number' && (
                              <span className="text-[11px] font-mono font-medium text-[#1B4332] dark:text-[#82C9A5] tabular-nums">
                                {formatDistance(org.distanceMeters)}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[#4F5E55] dark:text-[#B8C7BE]">{org.address}</p>
                          <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                            {org.phone ? (
                              <a
                                href={`tel:${org.phone.replace(/[^\d+]/g, '')}`}
                                className="inline-flex items-center gap-1 text-[#1B4332] dark:text-[#82C9A5] font-medium hover:underline"
                              >
                                <Phone className="w-3 h-3" />
                                {org.phone}
                              </a>
                            ) : (
                              <span className="text-[#6B7A70] dark:text-[#869B8F]">
                                Phone not listed on Google Maps
                              </span>
                            )}
                          </p>
                        </div>

                        <div className="flex flex-wrap sm:flex-col items-center sm:items-end gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              if (isSelected) {
                                onSelectOrganisation(null);
                              } else {
                                onSelectOrganisation(org);
                                setMapCenter({ lat: org.latitude, lng: org.longitude });
                                setActiveInfoPlaceId(org.placeId);
                              }
                            }}
                            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors cursor-pointer whitespace-nowrap inline-flex items-center gap-1 ${
                              isSelected
                                ? 'bg-[#1B4332] dark:bg-[#2D6A4F] text-white'
                                : 'bg-[#EEF3EC] dark:bg-[#1B3328] text-[#1B4332] dark:text-[#82C9A5] hover:bg-[#DFEBDD] dark:hover:bg-[#244234]'
                            }`}
                          >
                            {isSelected && <CheckCircle2 className="w-3.5 h-3.5" />}
                            {isSelected ? 'Selected' : 'Select Organisation'}
                          </button>

                          <div className="flex items-center gap-2">
                            {org.directionsUri && (
                              <a
                                href={org.directionsUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1 rounded-lg border border-[#DCE0D8] dark:border-[#2B3B32] bg-white dark:bg-[#17211C] text-[11px] font-medium text-[#1A2820] dark:text-[#EBF2ED] hover:bg-[#FAF9F6] dark:hover:bg-[#1F2D25] inline-flex items-center gap-1"
                              >
                                <Navigation className="w-3 h-3 text-[#1B4332] dark:text-[#82C9A5]" />
                                Get Directions
                              </a>
                            )}
                            {org.googleMapsUri && (
                              <a
                                href={org.googleMapsUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1 rounded-lg border border-[#DCE0D8] dark:border-[#2B3B32] bg-white dark:bg-[#17211C] text-[11px] font-medium text-[#5A6A60] dark:text-[#9CB0A4] hover:text-[#1A2820] dark:hover:text-[#EBF2ED] inline-flex items-center gap-1"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Maps
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </APIProvider>
  );
}
